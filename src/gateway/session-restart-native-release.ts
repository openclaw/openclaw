import {
  canReleaseNativeRestartQueue,
  finishNativeRestartQueueRelease,
} from "../config/sessions/session-native-restart-recovery.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { withAgentInputRecovery } from "../state/agent-database-preparation-context.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import type { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";
import type {
  PreparedRestartStore,
  RestartResumeParams,
} from "./session-restart-resume-discovery.js";

/** Install the input barrier before opening admission, including for a hold with an empty queue. */
export async function prepareNativeRestartQueueRelease({
  context,
  signal,
  log,
  target,
  sessions,
  nativeRecovery,
  deferred,
  assertCurrent: assertRecoveryCurrent,
  ownsInput,
  resume,
}: RestartResumeParams &
  Pick<PreparedRestartStore, "target" | "sessions"> &
  Awaited<ReturnType<typeof prepareRestartCompletionCustody>> & {
    nativeRecovery: ReadonlyMap<string, InternalSessionEntry>;
    deferred: Map<string, () => Promise<void>>;
  }): Promise<boolean> {
  let completed = true;
  for (const [sessionKey, entry] of nativeRecovery) {
    const scope = {
      ...target,
      agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
      sessionKey,
      sessionId: entry.sessionId,
    };
    const recovery = entry.nativeRestartRecovery!;
    let flight: Promise<void> | undefined;
    let replay: Awaited<ReturnType<typeof continueSessionQueuedInputs>>;
    const release = () => {
      flight ??= runWithGatewayIndependentRootWorkAdmission(
        () =>
          withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, async () => {
            if (
              !(await canReleaseNativeRestartQueue(
                scope,
                entry,
                Boolean(replay),
                assertRecoveryCurrent,
              ))
            ) {
              deferred.delete(sessionKey);
              return;
            }
            await withAgentInputRecovery(
              context.agentDatabaseStartup,
              target.physicalAgentId,
              async () => {
                if (replay) {
                  await replay.resume();
                } else {
                  replay = await continueSessionQueuedInputs(context, scope, {
                    signal,
                    assertCurrent: assertRecoveryCurrent,
                    ownsInput: (row) => ownsInput(row, scope.agentId),
                  });
                  if (replay) {
                    throw replay.error;
                  }
                }
                await finishNativeRestartQueueRelease(scope, entry, assertRecoveryCurrent);
              },
            );
            deferred.delete(sessionKey);
            resume((key) => key === sessionKey);
          }),
        "startup:native-recovery-release",
        signal,
      ).finally(() => {
        flight = undefined;
      });
      return flight;
    };
    deferred.set(sessionKey, release);
    try {
      // A crash after acknowledgement resumes the queue, not the old native turn.
      if (recovery.state === "releasing") {
        await release();
      }
    } catch (error) {
      signal.throwIfAborted();
      completed = false;
      log.warn(
        `Native recovery is waiting to release queued inputs for ${sessionKey}: ${String(error)}`,
      );
    } finally {
      sessions.get(sessionKey)?.resolve();
    }
  }
  return completed;
}
