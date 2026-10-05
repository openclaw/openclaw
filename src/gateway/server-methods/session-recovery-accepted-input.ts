import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsRecoverResult } from "../../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent.js";
import { readMainSessionRecoveryCheckpoint } from "../../agents/main-session-recovery/main-session-restart-recovery-checkpoint.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import type { TurnRecoveryIntent } from "../../config/sessions/main-session-recovery.types.js";
import {
  readSessionPendingInputStage,
  withSessionPendingInputQueue,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { readPendingInputRecoveryIntent } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { prepareRecoverySource } from "../session-recovery-source.js";
import { findCanonicalStoreMatch } from "../session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Recover the original server-held foreground input; the paused Goal is a separate intent. */
export async function recoverAcceptedSessionInput(
  options: GatewayRequestHandlerOptions,
  request: { key: string; agentId?: string },
  commitGuard?: () => void,
): Promise<SessionsRecoverResult | undefined> {
  const { context, client } = options;
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: context.getRuntimeConfig(),
    key: request.key,
    agentId: request.agentId,
    assertActive: commitGuard,
  });
  const initial = findCanonicalStoreMatch(target.store, target.storeKeys)?.entry;
  if (
    initial?.status !== "interrupted" ||
    initial.abortedLastRun !== true ||
    initial.goal?.status !== "paused" ||
    initial.goalPauseOrigin !== "manual" ||
    !initial.mainRestartRecovery ||
    initial.mainRestartRecovery.pause ||
    initial.mainRestartRecovery.acknowledgedPause ||
    initial.mainRestartRecovery.tombstone
  ) {
    return undefined;
  }
  function reject(message: string): never {
    throw new Error(message);
  }
  const runtime = context.recoveryRuntime;
  if (!runtime?.prepareGoalRecoveryAuthority) {
    reject("Accepted input recovery authority is unavailable.");
  }
  using source = await prepareRecoverySource({
    cfg: context.getRuntimeConfig(),
    target,
    commitGuard,
  });
  const identities = [...target.storeKeys, initial.sessionId];
  const scope = {
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
    sessionId: initial.sessionId,
  };
  let accepted = initial;
  let inputClaimed = false;
  let assertPlacementCurrent: (() => void) | undefined;
  const assertCurrent = () => {
    commitGuard?.();
    if (options.hasCurrentClientAuthority && !options.hasCurrentClientAuthority()) {
      reject("Recovery caller authority changed.");
    }
    const current = inputClaimed ? undefined : source.current();
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "recover",
      entry: current ?? accepted,
      key: target.canonicalKey,
      pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
    });
    if (ownershipError) {
      reject(ownershipError.message);
    }
    if (
      (!inputClaimed && !isDeepStrictEqual(current, accepted)) ||
      isEmbeddedAgentRunActive(initial.sessionId) ||
      isCompetingSessionWorkAdmissionActive(target.storePath, identities)
    ) {
      reject("Session changed or has active work; refresh before recovery.");
    }
    const error = !inputClaimed && resolveSessionWorkStartError(target.canonicalKey, current);
    if (error) {
      reject(error);
    }
    assertPlacementCurrent?.();
    prepared?.authority.assertCurrent();
  };
  let prepared:
    | Awaited<ReturnType<NonNullable<typeof runtime.prepareGoalRecoveryAuthority>>>
    | undefined;
  const admission = await beginSessionWorkAdmission({
    scope: target.storePath,
    identities,
    storeWriterIdentities: target.storeKeys,
    assertAllowed: async () => {
      await source.refresh();
      assertCurrent();
    },
  });
  let transferred = false;
  try {
    return await admission.run(async () => {
      const claimed = await runExclusiveSessionLifecycleMutation("recover", {
        scope: target.storePath,
        identities,
        run: async () => {
          await source.refresh();
          assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
            context: resolveSessionWorkerPlacementContext(context),
            sessionId: initial.sessionId,
          });
          assertCurrent();
          const checkpoint = await readMainSessionRecoveryCheckpoint(scope);
          assertCurrent();
          if (checkpoint.unresolvedEffect) {
            reject(
              "An interrupted external action has no verified outcome. Review it before recovering accepted input.",
            );
          }
          return await withSessionPendingInputQueue(scope, assertCurrent, async (queue) => {
            const committedSnapshot = await queue.readCommitted();
            if (committedSnapshot.effectHold) {
              reject(
                "An interrupted external action has no verified outcome. Review it before recovering committed input.",
              );
            }
            if (committedSnapshot.blocked) {
              reject("Committed input provenance or terminal state does not allow re-admission.");
            }
            const committed = committedSnapshot.input;
            if (committed) {
              if (client?.authenticatedUserProfile?.profileId !== committed.profileId) {
                reject("Only the original authenticated issuer can recover this committed input.");
              }
              const saved = initial.mainRestartRecovery?.turnIntent;
              const intent: TurnRecoveryIntent =
                saved?.inputId === committed.inputId && saved.runId === committed.runId
                  ? saved
                  : await (async () => {
                      const current = await captureGatewayOperatorRunAuthority({
                        client,
                        context,
                        hasCurrentClientAuthority: options.hasCurrentClientAuthority,
                      });
                      if (!current) {
                        reject("Current original-user recovery authority is unavailable.");
                      }
                      prepared = current;
                      const issuer = current.authority.captureRestartRecoveryIssuer?.();
                      if (
                        !issuer ||
                        issuer.profileId !== committed.profileId ||
                        issuer.factoryActor.accountId !==
                          client?.authenticatedFactoryGitHubAccountId
                      ) {
                        reject(
                          "Committed input recovery requires verified original-user authority.",
                        );
                      }
                      return {
                        inputId: committed.inputId,
                        runId: committed.runId,
                        idempotencyKey: committed.idempotencyKey,
                        sessionId: initial.sessionId,
                        sessionKey: target.canonicalKey,
                        lifecycleRevision: initial.lifecycleRevision,
                        repositoryWorkspaceId: initial.repositoryWorkspaceId,
                        lifecycleGeneration: getAgentEventLifecycleGeneration(),
                        issuer,
                      };
                    })();
              if (intent === saved) {
                if (
                  intent.issuer.factoryActor.accountId !==
                  client?.authenticatedFactoryGitHubAccountId
                ) {
                  reject(
                    "Only the original authenticated issuer can recover this committed input.",
                  );
                }
                prepared = await runtime.prepareGoalRecoveryAuthority!(intent, {
                  agentId: target.agentId,
                  sessionKey: target.canonicalKey,
                  explicitAcceptedInput: {
                    predecessor: saved,
                    profileId: committed.profileId,
                    accountId: intent.issuer.factoryActor.accountId,
                    goalId: initial.goal!.id,
                    pausedAt: initial.goal!.pausedAt,
                  },
                });
              }
              assertCurrent();
              const result = await queue.recoverCommitted({
                expectedEntry: accepted,
                input: committed,
                intent,
                lifecycleGeneration: getAgentEventLifecycleGeneration(),
              });
              if (!result) {
                reject(
                  "Committed input changed or has a terminal outcome; refresh before recovery.",
                );
              }
              accepted = result.entry;
              inputClaimed = true;
              await source.refresh();
              assertCurrent();
              return intent;
            }
            const snapshot = await queue.read();
            const row = snapshot.rows[0];
            if (!snapshot.current || !row) {
              reject("No unconsumed accepted input is available.");
            }
            const input = await readSessionPendingInputStage(
              scope,
              row.idempotency_key,
              assertCurrent,
            );
            const capture = input.existing && readPendingInputRecoveryIntent(input.existing);
            if (
              !capture?.queued ||
              input.existing?.consumed_event_id !== null ||
              capture.intent.inputId !== row.input_id ||
              client?.authenticatedUserProfile?.profileId !== capture.intent.issuer.profileId ||
              client?.authenticatedFactoryGitHubAccountId !==
                capture.intent.issuer.factoryActor.accountId
            ) {
              reject("Only the original authenticated issuer can recover this accepted input.");
            }
            prepared = await runtime.prepareGoalRecoveryAuthority!(capture.intent, {
              agentId: target.agentId,
              sessionKey: target.canonicalKey,
              explicitAcceptedInput: {
                predecessor: initial.mainRestartRecovery?.turnIntent,
                profileId: capture.intent.issuer.profileId,
                accountId: capture.intent.issuer.factoryActor.accountId,
                goalId: initial.goal!.id,
                pausedAt: initial.goal!.pausedAt,
              },
            });
            assertCurrent();
            prepared.authority.assertCurrent();
            const result = await queue.recoverAccepted({
              expectedEntry: accepted,
              row,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            });
            if (!result) {
              reject("Accepted input changed before recovery; refresh and retry.");
            }
            accepted = result.entry;
            inputClaimed = true;
            await source.refresh();
            assertCurrent();
            return capture.intent;
          });
        },
      });
      assertCurrent();
      const original = await readSessionPendingInputStage(
        scope,
        claimed.idempotencyKey,
        assertCurrent,
      );
      const message = prepared!.prepareAcceptedInput
        ? await prepared!.prepareAcceptedInput(assertCurrent)
        : original.committed?.messageId === claimed.inputId &&
            typeof original.committed.message.content === "string"
          ? original.committed.message.content
          : undefined;
      if (message === undefined) {
        reject("The saved accepted input cannot be re-admitted.");
      }
      assertCurrent();
      const started = createDeferredCore<{ runId: string }>();
      let dispatchAccepted = false;
      const dispatch = runtime.dispatchAgent<{ runId: string }>(
        {
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          expectedExistingSessionId: initial.sessionId,
          message,
          idempotencyKey: claimed.runId,
          internalRuntimeHandoffId: admission.createHandoff(),
          deliver: false,
          inputProvenance: {
            kind: "internal_system",
            sourceSessionKey: target.canonicalKey,
            sourceTool: "sessions.recover",
          },
        },
        undefined,
        {
          expectFinal: true,
          onAccepted: (payload) => {
            if (!isRecord(payload) || payload.runId !== claimed.runId) {
              reject("Recovery accepted a different input identity.");
            }
            dispatchAccepted = true;
            started.resolve({ runId: claimed.runId });
          },
          operatorRunAuthority: prepared!.authority,
          assertAdmissionCurrent: () => {
            if (!dispatchAccepted) {
              commitGuard?.();
              if (options.hasCurrentClientAuthority && !options.hasCurrentClientAuthority()) {
                reject("Recovery caller authority changed.");
              }
            }
            prepared!.authority.assertCurrent();
          },
        },
      );
      // The child adopts this exact admission. Acceptance ends the RPC, not the lease.
      transferred = true;
      const settled = dispatch.finally(() => {
        admission.release();
        prepared?.release();
      });
      void settled.catch(() => {}); // Agent dispatch owns its visible terminal error and receipt.
      const result = await Promise.race([started.promise, settled]);
      return {
        ok: true,
        key: target.canonicalKey,
        sessionId: initial.sessionId,
        continuation: { status: "started", runId: result.runId },
      };
    });
  } finally {
    if (!transferred) {
      admission.release();
      prepared?.release();
    }
  }
}
