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
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
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
  const closingAttachments = new Map<string, number>();
  const cleanups = new KeyedAsyncQueue();
  // Runtime retry budgets reset on restart; the durable lease remains owned throughout.
  const cleanupRetries = new Map<
    string,
    {
      ownerEpoch: number;
      leaseId: string | null;
      startedAtMs: number;
      attempts: number;
      nextAttemptAtMs: number;
      lastError: string;
      parked?: string;
    }
  >();
  const cleanupRetry = (record: WorkerEnvironmentRecord) => {
    const retry = cleanupRetries.get(record.environmentId);
    if (
      retry &&
      (retry.ownerEpoch !== record.ownerEpoch ||
        retry.leaseId !== record.leaseId ||
        ["destroyed", "failed"].includes(record.state))
    ) {
      cleanupRetries.delete(record.environmentId);
      return undefined;
    }
    return retry;
  };
  const parkCleanup = (
    record: WorkerEnvironmentRecord,
    retry: NonNullable<ReturnType<typeof cleanupRetry>>,
  ) => {
    if (!retry.parked) {
      const nextStep =
        record.providerId === "crabbox"
          ? `Run crabbox stop ${record.leaseId ?? "<lease>"} or crabbox leases list, then retry Stop.`
          : "Check the provider lease, then retry Stop.";
      retry.parked = `Conversation environment cleanup parked (${record.leaseId ?? record.environmentId}) after ${retry.attempts} attempts: ${retry.lastError}. ${nextStep}`;
      options.warn(retry.parked);
    }
  };
  const destroyEnvironment = (environmentId: string, explicit = false) =>
    cleanups.enqueue(environmentId, async () => {
      await store.ready();
      const record = store.get(environmentId);
      if (!record) {
        cleanupRetries.delete(environmentId);
        return undefined;
      }
      const previous = cleanupRetry(record);
      if (explicit) {
        cleanupRetries.delete(environmentId);
      } else if (previous) {
        if (options.now() - previous.startedAtMs >= 3_600_000) {
          parkCleanup(record, previous);
        }
        if (previous.parked || options.now() < previous.nextAttemptAtMs) {
          return undefined;
        }
      }
      const retry = (!explicit && previous) || {
        ownerEpoch: record.ownerEpoch,
        leaseId: record.leaseId,
        startedAtMs: options.now(),
        attempts: 0,
        nextAttemptAtMs: 0,
        lastError: "",
      };
      retry.attempts += 1;
      try {
        const stopped = await providerLifecycle.destroy(environmentId, { requireUnattached: true });
        if (
          stopped.state !== "destroyed" &&
          !(stopped.state === "failed" && stopped.leaseId === null)
        ) {
          throw new Error(
            `Conversation environment cleanup is not confirmed (${stopped.state}); the existing lease remains owned`,
          );
        }
        cleanupRetries.delete(environmentId);
        return stopped;
      } catch (error) {
        const current = store.get(environmentId)!;
        retry.ownerEpoch = current.ownerEpoch;
        retry.leaseId = current.leaseId;
        retry.lastError = boundedWorkerError(error);
        retry.nextAttemptAtMs =
          options.now() + Math.min(30_000 * 2 ** (retry.attempts - 1), 300_000);
        cleanupRetries.set(environmentId, retry);
        if (retry.attempts >= 10 || options.now() - retry.startedAtMs >= 3_600_000) {
          parkCleanup(current, retry);
        } else if (!explicit) {
          options.warn(
            `Conversation environment cleanup will retry (${environmentId}): ${retry.lastError}`,
          );
        }
        if (explicit) {
          throw error;
        }
        return undefined;
      }
    });
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
    prepared?: WorkerEnvironmentSessionIdentity,
  ): WorkerEnvironmentAttachment | undefined => {
    if (
      !record ||
      record.closedAtMs !== null ||
      closingAttachments.has(record.sessionId) ||
      options.isStopping() ||
      !(prepared
        ? record.sessionId === prepared.sessionId &&
          record.sessionKey === prepared.sessionKey &&
          record.agentId === prepared.agentId &&
          record.sessionLifecycleRevision === prepared.sessionLifecycleRevision
        : currentSession(record))
    ) {
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
  const assertSessionAttachment = (
    binding: WorkerEnvironmentAttachment,
    prepared?: WorkerEnvironmentSessionIdentity,
  ) => {
    const current = project(store.getSessionAttachmentRecord(binding.sessionId), prepared);
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
  const touchSessionAttachment = async (
    binding: WorkerEnvironmentAttachment,
    assertCurrent: () => void = () => assertSessionAttachment(binding),
  ) => {
    await store.ready();
    assertCurrent();
    await store.touchSessionAttachment(
      store.getSessionAttachmentRecord(binding.sessionId)!,
      assertCurrent,
    );
    assertCurrent();
  };
  const close = async (
    sessionId: string,
    authorize: () => void,
    environmentId?: string,
    keepCreation?: AbortController,
    explicit = false,
  ) => {
    authorize();
    closingAttachments.set(sessionId, (closingAttachments.get(sessionId) ?? 0) + 1);
    try {
      await store.ready();
      const closed = await store.closeSessionAttachment(sessionId, () => {
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
      return await destroyEnvironment(closed.environmentId, explicit);
    } finally {
      const remaining = closingAttachments.get(sessionId)! - 1;
      if (remaining === 0) {
        closingAttachments.delete(sessionId);
      } else {
        closingAttachments.set(sessionId, remaining);
      }
    }
  };
  const attachments = {
    getCleanupError: (record: WorkerEnvironmentRecord): string | undefined =>
      cleanupRetry(record)?.parked,
    captureSessionAttachment(identity: WorkerEnvironmentSessionIdentity) {
      // Admission already read the canonical session. Its identity plus synchronous
      // retirement fences avoid repeating that SQLite read on each proxy connection.
      const binding = project(store.getSessionAttachmentRecord(identity.sessionId), identity);
      if (!binding) {
        throw new Error("No current environment is attached to this conversation");
      }
      const assertCurrent = () => assertSessionAttachment(binding, identity);
      return {
        binding,
        assertCurrent,
        touch: () => touchSessionAttachment(binding, assertCurrent),
      };
    },
    cancelSessionAttachmentCreations() {
      for (const pending of creations.values()) {
        for (const creation of pending) {
          creation.abort(new Error("Worker environment service is stopping"));
        }
      }
    },
    getSessionAttachment: (sessionId: string) =>
      closingAttachments.has(sessionId)
        ? undefined
        : project(store.getSessionAttachmentRecord(sessionId)),
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
        ? {
            attachment: { ...record, ownerEpoch: environment.ownerEpoch },
            environment: options.environmentAccess.project(environment),
          }
        : undefined;
    },
    assertSessionAttachment,
    touchSessionAttachment: (binding: WorkerEnvironmentAttachment) =>
      touchSessionAttachment(binding),
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
        await store.ready();
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
            await store.touchSessionAttachment(attachment, assertCurrent);
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
                const reservation = await store.createSessionAttachmentIntent(
                  {
                    ...request,
                    ...environmentIntent,
                    providerId: intent.providerId,
                    profileSnapshot: intent.profileSnapshot,
                  },
                  assertCurrent,
                );
                reservationCreated = true;
                const cancelReservation = async () => {
                  const current = store.get(reservation.environment.environmentId);
                  if (current?.state === "requested") {
                    await store.cancelSessionAttachmentReservation(reservation.attachment);
                  } else {
                    await store.closeSessionAttachment(request.sessionId, () => {
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
                  await cancelReservation();
                  throw authorityFailure ? authorityFailure.error : error;
                }
              })
              .catch(async (error: unknown) => {
                if (reservationCreated) {
                  await destroyEnvironment(environmentIntent.environmentId).catch(
                    (cleanupError: unknown) =>
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
      return options.trackOperation(
        close(request.sessionId, authorize, request.environmentId, undefined, true).then(
          (record) => (record ? options.environmentAccess.project(record) : undefined),
        ),
      );
    },
    async reconcileSessionAttachments() {
      await store.ready();
      for (const environmentId of cleanupRetries.keys()) {
        const record = store.get(environmentId);
        if (record) {
          cleanupRetry(record);
        } else {
          cleanupRetries.delete(environmentId);
        }
      }
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
          environment.destroyRequestedAtMs === null &&
          sessionCurrent &&
          (options.hasAttachedEnvironmentActivity?.(record.environmentId, environment.ownerEpoch) ||
            listAgentRunsForSession(record).some((run) => hasLiveAgentRunContext(run.runId)));
        if (active) {
          await store.touchSessionAttachment(record, () => {});
          continue;
        }
        const suspendAfter =
          options.getConfig().cloudWorkers?.profiles?.[environment.profileId]?.suspendAfter;
        const expired =
          suspendAfter && options.now() - record.lastUsedAtMs >= parseDurationMs(suspendAfter);
        if (
          record.closedAtMs !== null ||
          environment.destroyRequestedAtMs !== null ||
          !sessionCurrent ||
          expired
        ) {
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
          .trackOperation(close(mutation.previous.sessionId, () => {}))
          .catch((error: unknown) =>
            options.warn(
              `Conversation environment cleanup will retry during reconciliation: ${boundedWorkerError(error)}`,
            ),
          );
      }
    },
    createSessionAttachment: (...args: Parameters<typeof attachments.createSessionAttachment>) =>
      options.trackOperation(
        attachments.createSessionAttachment(...args).then((result) => ({
          ...result,
          environment: options.environmentAccess.project(result.environment),
        })),
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
      await attachments.touchSessionAttachment(binding);
      command.assertCurrent?.();
      const result = await options.runSessionEnvironmentCommand(binding, {
        ...command,
        assertCurrent: () => {
          attachments.assertSessionAttachment(binding);
          command.assertCurrent?.();
        },
      });
      attachments.assertSessionAttachment(binding);
      await attachments.touchSessionAttachment(binding);
      command.assertCurrent?.();
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
