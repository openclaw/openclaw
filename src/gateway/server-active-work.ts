// Adapts server-local chat and terminal state to the shared activity inspector.
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const isActiveChatRun = (entry: ChatAbortControllerEntry) =>
  !entry.controller.signal.aborted && entry.registrationCleanupRequested !== true;

const hasTerminalPersistence = (entry: ChatAbortControllerEntry) =>
  entry.controlUiVisible !== false &&
  entry.projectSessionTerminalPersisted !== true &&
  (entry.projectSessionTerminalPending === true ||
    entry.projectSessionTerminalPersistence !== undefined);

export function createGatewayServerActiveWorkInspectors(
  context: Pick<
    GatewayRequestContext,
    "chatAbortControllers" | "chatQueuedTurns" | "terminalSessions"
  > & { cron: Pick<GatewayRequestContext["cron"], "getSuspensionBlockerCount"> },
): Partial<GatewayActiveWorkInspectors> {
  const holders = (matches: (entry: ChatAbortControllerEntry) => boolean) =>
    Array.from(context.chatAbortControllers)
      .filter(([, entry]) => matches(entry))
      .map(([runId, entry]) => `run=${runId} session=${entry.sessionKey}`);
  return {
    getCronRuns: () =>
      Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()) +
      (context.cron.getSuspensionBlockerCount?.() ?? 0),
    getChatRuns: () =>
      Array.from(context.chatAbortControllers.values()).filter(isActiveChatRun).length,
    getChatRunHolders: () => holders(isActiveChatRun),
    getQueuedTurns: () =>
      Array.from(context.chatQueuedTurns.values()).filter(
        (entry) => !entry.controller.signal.aborted,
      ).length,
    getTerminalPersistence: () =>
      Array.from(context.chatAbortControllers.values()).filter(hasTerminalPersistence).length,
    getTerminalPersistenceHolders: () => holders(hasTerminalPersistence),
    getTerminalPersistenceDiagnostics: () => {
      const pending = Array.from(context.chatAbortControllers).filter(([, entry]) =>
        hasTerminalPersistence(entry),
      );
      const now = Date.now();
      let oldestAgeMs: number | null = 0;
      for (const [, entry] of pending) {
        const observedAt = entry.projectSessionTerminalObservedAt;
        if (observedAt === undefined) {
          oldestAgeMs = null;
          break;
        }
        oldestAgeMs = Math.max(oldestAgeMs, now - observedAt);
      }
      return {
        oldestAgeMs,
        // Diagnostics leave the process here: omit session keys and redact before truncation.
        runIds: pending.slice(0, 8).map(([runId]) =>
          redactSensitiveText(runId, { mode: "tools" })
            .replace(/\p{Cc}/gu, " ")
            .slice(0, 256),
        ),
      };
    },
    getTerminalSessions: () => context.terminalSessions?.size ?? 0,
  };
}
