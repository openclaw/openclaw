import { isClaudeCliProvider } from "../../agents/cli-runner/helpers.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { clearCliSession, getCliSessionId } from "../../agents/cli-session.js";
import { clearCliSessionInStore } from "../../agents/command/session-store.js";
import { isFailoverError } from "../../agents/failover-error.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions.js";
import { formatErrorMessage, readErrorName } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("auto-reply/cli-session-recovery");

type CliSessionRecoveryParams = {
  provider: string;
  binding?: CliSessionBinding;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  hasCommittedMedia: () => boolean;
};

type CliSessionRecoveryCallbacks = {
  onErrorBeforeLifecycle?: (error: unknown) => Promise<void>;
  onBeforeFreshCliSessionRetry?: RunCliAgentParams["onBeforeFreshCliSessionRetry"];
};

async function clearExpectedCliSessionBinding(params: {
  provider: string;
  expectedCliSessionId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  activeSessionEntry?: SessionEntry;
}): Promise<boolean> {
  const { provider, expectedCliSessionId, sessionKey, sessionStore, storePath } = params;
  if (!sessionKey || !sessionStore || !storePath) {
    return false;
  }
  const storedEntry = sessionStore[sessionKey];
  if (
    !storedEntry?.sessionId ||
    getCliSessionId(storedEntry, provider) !== expectedCliSessionId ||
    (params.activeSessionEntry !== undefined &&
      getCliSessionId(params.activeSessionEntry, provider) !== undefined &&
      getCliSessionId(params.activeSessionEntry, provider) !== expectedCliSessionId)
  ) {
    return false;
  }

  try {
    const cleared = await clearCliSessionInStore({
      provider,
      sessionKey,
      sessionStore,
      storePath,
      expectedSessionId: storedEntry.sessionId,
      expectedCliSessionId,
    });
    if (!cleared) {
      return false;
    }
    for (const entry of new Set(
      [storedEntry, params.activeSessionEntry].filter(
        (candidate): candidate is SessionEntry => candidate !== undefined,
      ),
    )) {
      if (getCliSessionId(entry, provider) === expectedCliSessionId) {
        clearCliSession(entry, provider);
        entry.updatedAt = cleared.updatedAt;
      }
    }
    return true;
  } catch (error) {
    log.warn(`failed to clear stale CLI session binding: ${formatErrorMessage(error)}`);
    return false;
  }
}

export function createCliSessionRecoveryCallbacks(
  params: CliSessionRecoveryParams,
): CliSessionRecoveryCallbacks {
  const sessionId = params.binding?.sessionId;
  if (!sessionId || !params.sessionKey || !params.sessionStore || !params.storePath) {
    return {};
  }

  const clearExpected = (provider: string, expectedCliSessionId: string) =>
    clearExpectedCliSessionBinding({
      provider,
      expectedCliSessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      activeSessionEntry: params.getActiveSessionEntry(),
    });

  const callbacks: CliSessionRecoveryCallbacks = {
    onBeforeFreshCliSessionRetry: async ({ provider, sessionId: retrySessionId }) => {
      // A generated-media side effect makes replaying this turn unsafe, but
      // the expired binding must still be cleared before a later turn resumes it.
      if (params.hasCommittedMedia()) {
        await clearExpected(provider, retrySessionId);
        return false;
      }
      return clearExpected(provider, retrySessionId);
    },
  };
  if (params.binding?.forkNextResume === true) {
    return callbacks;
  }
  callbacks.onErrorBeforeLifecycle = async (error) => {
    if (
      isClaudeCliProvider(params.provider) &&
      (isFailoverError(error) || readErrorName(error) === "AbortError")
    ) {
      await clearExpected(params.provider, sessionId);
    }
  };
  return callbacks;
}
