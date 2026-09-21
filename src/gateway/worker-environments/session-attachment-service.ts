import { parseDurationMs } from "../../cli/parse-duration.js";
import {
  resolveSessionEntryAccessTarget,
  type SessionIdentityMutation,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { hasLiveAgentRunContext, listAgentRunsForSession } from "../../infra/agent-run-registry.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { createWorkerEnvironmentAccess } from "./environment-access.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import type { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type {
  WorkerEnvironmentAttachment,
  WorkerEnvironmentAttachmentRecord,
  WorkerEnvironmentSessionCreateRequest,
  WorkerEnvironmentSessionIdentity,
  WorkerEnvironmentSessionReservationHandler,
} from "./session-attachment.js";
import type { WorkerEnvironmentStore } from "./store.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";

export type WorkerEnvironmentSessionAttachmentOptions = {
  prepareAttachedComputer?: (
    authority: import("./computer-transport.js").WorkerEnvironmentComputerAuthority,
  ) => Promise<import("./computer-transport.js").PreparedWorkerComputer | undefined>;
  closeEnvironmentComputers?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
  hasAttachedEnvironmentActivity?: (environmentId: string, ownerEpoch: number) => boolean;
  runSessionEnvironmentCommand?: NodeWorkerTunnelManager["runSessionCommand"];
};

/** Owns conversation attachment authority; provider lifecycle continues to own every lease. */
export function createWorkerEnvironmentSessionAttachments(
  options: WorkerEnvironmentSessionAttachmentOptions & {
    store: WorkerEnvironmentStore;
    providerLifecycle: ReturnType<typeof createWorkerProviderLifecycle>;
    getConfig: () => OpenClawConfig;
    isStopping: () => boolean;
    now: () => number;
    warn: (message: string) => void;
    withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    environmentAccess: Pick<ReturnType<typeof createWorkerEnvironmentAccess>, "project">;
    nodePortalCarrier?: WorkerNodePortalCarrier;
  },
) {
  const { store, providerLifecycle } = options;
  const operations = new KeyedAsyncQueue();
  const creations = new Map<string, Set<AbortController>>();
  const currentSession = (identity: WorkerEnvironmentSessionIdentity) => {
    const target = resolveSessionEntryAccessTarget({
      cfg: options.getConfig(),
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
    });
    return (
      target.entry?.sessionId === identity.sessionId &&
      target.entry.incognito !== true &&
      target.entry.lifecycleRevision === identity.sessionLifecycleRevision
    );
  };
  const project = (
    record: WorkerEnvironmentAttachmentRecord | undefined,
  ): WorkerEnvironmentAttachment | undefined => {
    if (!record || record.closedAtMs !== null || options.isStopping() || !currentSession(record)) {
      return undefined;
    }
    const environment = store.get(record.environmentId);
    if (
      !environment ||
      (environment.state !== "ready" && environment.state !== "idle") ||
      environment.destroyRequestedAtMs !== null
    ) {
      return undefined;
    }
    return {
      sessionId: record.sessionId,
      sessionKey: record.sessionKey,
      agentId: record.agentId,
      ...(record.sessionLifecycleRevision
        ? { sessionLifecycleRevision: record.sessionLifecycleRevision }
        : {}),
      environmentId: record.environmentId,
      generation: record.generation,
      ownerEpoch: environment.ownerEpoch,
    };
  };
  const assertSessionAttachment = (binding: WorkerEnvironmentAttachment) => {
    const current = project(store.getSessionAttachmentRecord(binding.sessionId));
    if (
      !current ||
      current.environmentId !== binding.environmentId ||
      current.ownerEpoch !== binding.ownerEpoch ||
      current.generation !== binding.generation ||
      current.agentId !== binding.agentId ||
      current.sessionKey !== binding.sessionKey ||
      current.sessionLifecycleRevision !== binding.sessionLifecycleRevision
    ) {
      throw new Error("Conversation environment attachment is no longer current");
    }
  };
  const close = async (
    sessionId: string,
    authorize: () => void,
    environmentId?: string,
    keepCreation?: AbortController,
  ) => {
    const closed = store.closeSessionAttachment(sessionId, () => {
      authorize();
      const current = store.getSessionAttachmentRecord(sessionId);
      if (environmentId && current?.environmentId !== environmentId) {
        throw new Error("Conversation environment target changed");
      }
    });
    for (const creation of creations.get(sessionId) ?? []) {
      if (creation !== keepCreation) {
        creation.abort(new Error("Conversation environment was stopped"));
      }
    }
    if (!closed) {
      return undefined;
    }
    const stopped = await providerLifecycle.destroy(closed.environmentId, {
      requireUnattached: true,
    });
    if (
      stopped.state !== "destroyed" &&
      !(stopped.state === "failed" && stopped.leaseId === null)
    ) {
      throw new Error(
        `Conversation environment cleanup is not confirmed (${stopped.state}); the existing lease remains owned`,
      );
    }
    return stopped;
  };
  const attachments = {
    cancelSessionAttachmentCreations() {
      for (const pending of creations.values()) {
        for (const creation of pending) {
          creation.abort(new Error("Worker environment service is stopping"));
        }
      }
    },
    getSessionAttachment: (sessionId: string) =>
      project(store.getSessionAttachmentRecord(sessionId)),
    findSessionAttachment: (
      identity: Pick<WorkerEnvironmentSessionIdentity, "agentId" | "sessionKey">,
    ) => project(store.findSessionAttachmentRecord(identity)),
    getSessionAttachmentStatus(sessionId: string) {
      const record = store.getSessionAttachmentRecord(sessionId);
      if (!record) {
        return undefined;
      }
      const environment = store.get(record.environmentId);
      return environment
        ? { attachment: { ...record, ownerEpoch: environment.ownerEpoch }, environment }
        : undefined;
    },
    assertSessionAttachment,
    touchSessionAttachment(binding: WorkerEnvironmentAttachment) {
      assertSessionAttachment(binding);
      const record = store.getSessionAttachmentRecord(binding.sessionId)!;
      store.touchSessionAttachment(record, () => assertSessionAttachment(binding));
    },
    createSessionAttachment(
      input: WorkerEnvironmentSessionCreateRequest,
      authorize: () => void,
      callerSignal?: AbortSignal,
      onReserved?: WorkerEnvironmentSessionReservationHandler,
    ) {
      const sessionId = input.sessionId;
      const creation = new AbortController();
      const pending = creations.get(sessionId) ?? new Set<AbortController>();
      pending.add(creation);
      creations.set(sessionId, pending);
      return operations.enqueue(sessionId, async () => {
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, creation.signal])
          : creation.signal;
        try {
          const session = resolveSessionEntryAccessTarget({ cfg: options.getConfig(), ...input });
          const request = {
            ...input,
            sessionLifecycleRevision:
              input.sessionLifecycleRevision ?? session.entry?.lifecycleRevision,
          };
          const assertCurrent = () => {
            signal?.throwIfAborted();
            authorize();
            if (options.isStopping() || !currentSession(request)) {
              throw new Error("Conversation environment requester is no longer current");
            }
          };
          assertCurrent();
          let attachment = store.getSessionAttachmentRecord(request.sessionId);
          let environment = attachment && store.get(attachment.environmentId);
          if (attachment && attachment.closedAtMs === null && !currentSession(attachment)) {
            await close(request.sessionId, assertCurrent, attachment.environmentId, creation);
            assertCurrent();
            attachment = store.getSessionAttachmentRecord(request.sessionId);
            environment = attachment && store.get(attachment.environmentId);
          }
          const reused = Boolean(
            attachment &&
            environment &&
            attachment.closedAtMs === null &&
            !["destroyed", "failed", "orphaned"].includes(environment.state),
          );
          let allocationKey: string;
          if (reused && attachment && environment) {
            if (
              environment.profileId !== request.profileId ||
              (request.machineClass !== undefined &&
                environment.profileSnapshot.machineClass !== request.machineClass) ||
              (request.os !== undefined && environment.profileSnapshot.os !== request.os)
            ) {
              throw new Error(
                "Conversation already owns a different environment; stop it before selecting another profile or machine",
              );
            }
            if (environment.destroyRequestedAtMs !== null) {
              throw new Error("Conversation environment is stopping");
            }
            store.touchSessionAttachment(attachment, assertCurrent);
            // Recovery needs the stored environment identity, not a newly supplied retry key.
            const environmentId = environment.environmentId;
            await options.withLock(environmentId, async () => {
              assertCurrent();
              await onReserved?.({ environmentId, reused: true });
              assertCurrent();
              const current = store.get(environmentId);
              if (current) {
                await providerLifecycle.reconcileRecord(current, signal, undefined, assertCurrent);
              }
            });
          } else {
            allocationKey = JSON.stringify([
              "conversation",
              request.agentId,
              request.sessionId,
              request.idempotencyKey,
            ]);
            const intent = await providerLifecycle.prepareIntent(request.profileId, {
              machineClass: request.machineClass,
              os: request.os,
              signal,
            });
            assertCurrent();
            providerLifecycle.assertPreparedIntentCurrent(request.profileId, intent);
            const environmentIntent = deriveEnvironmentIntent(allocationKey);
            let reservationCreated = false;
            const reserved = await options
              .withLock(environmentIntent.environmentId, async () => {
                const reservation = store.createSessionAttachmentIntent(
                  {
                    ...request,
                    ...environmentIntent,
                    providerId: intent.providerId,
                    profileSnapshot: intent.profileSnapshot,
                  },
                  assertCurrent,
                );
                reservationCreated = true;
                const cancelReservation = () => {
                  const current = store.get(reservation.environment.environmentId);
                  if (current?.state === "requested") {
                    store.cancelSessionAttachmentReservation(reservation.attachment);
                  } else {
                    store.closeSessionAttachment(request.sessionId, () => {
                      const currentAttachment = store.getSessionAttachmentRecord(request.sessionId);
                      if (
                        currentAttachment?.environmentId !== reservation.attachment.environmentId ||
                        currentAttachment.generation !== reservation.attachment.generation
                      ) {
                        throw new Error(
                          "Conversation environment reservation changed before cleanup",
                        );
                      }
                    });
                  }
                };
                let authorityFailure: { error: unknown } | undefined;
                const assertProvisionCurrent = () => {
                  try {
                    assertCurrent();
                    providerLifecycle.assertPreparedIntentCurrent(request.profileId, intent);
                  } catch (error) {
                    authorityFailure ??= { error };
                    cancelReservation();
                    throw error;
                  }
                };
                try {
                  assertProvisionCurrent();
                  await onReserved?.({
                    environmentId: reservation.environment.environmentId,
                    reused: false,
                  });
                  assertProvisionCurrent();
                  // Retain this lock through allocation so queued recovery cannot bypass the
                  // requester's final-effect guard after reservation or presentation.
                  await providerLifecycle.reconcileRecord(
                    reservation.environment,
                    signal,
                    undefined,
                    assertProvisionCurrent,
                  );
                  if (authorityFailure) {
                    throw authorityFailure.error;
                  }
                  assertProvisionCurrent();
                  return reservation;
                } catch (error) {
                  cancelReservation();
                  throw authorityFailure ? authorityFailure.error : error;
                }
              })
              .catch(async (error: unknown) => {
                if (reservationCreated) {
                  await providerLifecycle
                    .destroy(environmentIntent.environmentId, { requireUnattached: true })
                    .catch((cleanupError: unknown) =>
                      options.warn(
                        `Cancelled conversation environment reservation cleanup will retry: ${boundedWorkerError(cleanupError)}`,
                      ),
                    );
                }
                throw error;
              });
            attachment = reserved.attachment;
          }
          assertCurrent();
          const current = store.getSessionAttachmentRecord(request.sessionId);
          if (
            !attachment ||
            current?.environmentId !== attachment.environmentId ||
            current.generation !== attachment.generation ||
            current.closedAtMs !== null
          ) {
            throw new Error("Conversation environment attachment changed during allocation");
          }
          const result = store.get(attachment.environmentId)!;
          if (result.state !== "ready" && result.state !== "idle") {
            throw new Error(result.lastError || `Conversation environment is ${result.state}`);
          }
          return {
            attachment: { ...current, ownerEpoch: result.ownerEpoch },
            environment: result,
            reused,
          };
        } finally {
          pending.delete(creation);
          if (pending.size === 0 && creations.get(sessionId) === pending) {
            creations.delete(sessionId);
          }
        }
      });
    },
    destroySessionAttachment(
      request: { sessionId: string; environmentId?: string },
      authorize: () => void,
    ) {
      // Close the durable relation before waiting for provisioning or transport cleanup.
      return close(request.sessionId, authorize, request.environmentId);
    },
    retireSessionAttachment(sessionId: string) {
      return close(sessionId, () => {});
    },
    async reconcileSessionAttachments() {
      for (const record of store.listSessionAttachmentRecords()) {
        if (options.isStopping()) {
          return;
        }
        const environment = store.get(record.environmentId);
        if (!environment || environment.state === "destroyed" || environment.state === "failed") {
          continue;
        }
        const sessionCurrent = currentSession(record);
        const active =
          record.closedAtMs === null &&
          sessionCurrent &&
          (options.hasAttachedEnvironmentActivity?.(record.environmentId, environment.ownerEpoch) ||
            listAgentRunsForSession(record).some((run) => hasLiveAgentRunContext(run.runId)));
        if (active) {
          store.touchSessionAttachment(record, () => {});
          continue;
        }
        const suspendAfter =
          options.getConfig().cloudWorkers?.profiles?.[environment.profileId]?.suspendAfter;
        const expired =
          suspendAfter && options.now() - record.lastUsedAtMs >= parseDurationMs(suspendAfter);
        if (record.closedAtMs !== null || !sessionCurrent || expired) {
          await close(
            record.sessionId,
            () => {
              const current = store.getSessionAttachmentRecord(record.sessionId);
              if (
                !current ||
                current.environmentId !== record.environmentId ||
                current.generation !== record.generation ||
                current.lastUsedAtMs !== record.lastUsedAtMs
              ) {
                throw new Error("Conversation environment changed before cleanup");
              }
            },
            record.environmentId,
          ).catch((error: unknown) =>
            options.warn(
              `Conversation environment cleanup will retry (${record.environmentId}): ${boundedWorkerError(error)}`,
            ),
          );
        }
      }
    },
  };
  return {
    ...attachments,
    retireSessionIdentityMutation(mutation: SessionIdentityMutation) {
      const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
      if (
        mutation.previous.sessionId &&
        (mutation.previous.sessionId !== currentSessionId || mutation.kind === "reset")
      ) {
        void options
          .trackOperation(attachments.retireSessionAttachment(mutation.previous.sessionId))
          .catch((error: unknown) =>
            options.warn(
              `Conversation environment cleanup will retry during reconciliation: ${boundedWorkerError(error)}`,
            ),
          );
      }
    },
    getSessionAttachmentStatus: (sessionId: string) => {
      const result = attachments.getSessionAttachmentStatus(sessionId);
      return result
        ? { ...result, environment: options.environmentAccess.project(result.environment) }
        : undefined;
    },
    createSessionAttachment: (...args: Parameters<typeof attachments.createSessionAttachment>) =>
      options.trackOperation(
        attachments.createSessionAttachment(...args).then((result) => ({
          ...result,
          environment: options.environmentAccess.project(result.environment),
        })),
      ),
    destroySessionAttachment: (...args: Parameters<typeof attachments.destroySessionAttachment>) =>
      options.trackOperation(
        attachments
          .destroySessionAttachment(...args)
          .then((record) => (record ? options.environmentAccess.project(record) : undefined)),
      ),
    prepareAttachedComputer: options.prepareAttachedComputer,
    execSessionAttachment: async (
      binding: WorkerEnvironmentAttachment,
      command: WorkerWorkspaceCommand,
    ) => {
      attachments.assertSessionAttachment(binding);
      if (!options.runSessionEnvironmentCommand) {
        throw new Error("Worker node execution transport is unavailable");
      }
      attachments.touchSessionAttachment(binding);
      const result = await options.runSessionEnvironmentCommand(binding, {
        ...command,
        assertCurrent: () => {
          attachments.assertSessionAttachment(binding);
          command.assertCurrent?.();
        },
      });
      attachments.assertSessionAttachment(binding);
      attachments.touchSessionAttachment(binding);
      return result;
    },
    openNodePortal: (request: {
      environmentId: string;
      ownerEpoch: number;
      remotePort: number;
    }) => {
      if (!options.nodePortalCarrier) {
        throw new Error("Worker node portal transport is unavailable");
      }
      return options.nodePortalCarrier.open(request);
    },
  };
}
