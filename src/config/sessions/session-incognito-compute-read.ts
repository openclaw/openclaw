import path from "node:path";
import type { BuildSessionEntryOptions } from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { createCodexSessionContextReader } from "../../plugin-sdk/codex-session-transcript-runtime.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type {
  IncognitoContextReadResult,
  IncognitoHistoryTarget,
} from "./session-incognito-history-contract.js";
import { prepareIncognitoSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";

async function readContextResult<Value>(
  result: Promise<IncognitoContextReadResult<Value>>,
): Promise<Value> {
  const settled = await result;
  if (!settled.ok) {
    throw new SessionTranscriptReadFenceError(settled.message);
  }
  return settled.value;
}

/** Inactive adapters retain one actor; P7 supplies them to the production owners. */
export function bindIncognitoSessionComputeReader(params: {
  actor: IncognitoAgentDatabaseExecution;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget;
  signal?: AbortSignal;
}) {
  const { actor, authority, signal } = params;
  actor.assertCurrent();
  authority.assertCurrent();
  const target = structuredClone(params.target);
  const identity = { ...target, agentId: actor.agentId, storePath: actor.path };
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const disclose = () => {
    signal?.throwIfAborted();
    claim.authorize(authority, "commit");
    actor.assertCurrent();
  };
  const assertScope = (scope: Partial<SessionTranscriptReadScope>) => {
    disclose();
    if (
      (scope.sessionId !== undefined && scope.sessionId !== target.sessionId) ||
      (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
      (scope.agentId !== undefined && scope.agentId !== actor.agentId) ||
      (scope.storePath !== undefined && path.resolve(scope.storePath) !== actor.path)
    ) {
      throw new Error("Incognito compute read belongs to another session or store");
    }
  };
  const retain = <T>(operation: () => Promise<T>) =>
    actor.sessions.withCompute(authority, target, operation, signal);
  return {
    prepareHydration(
      limits?: Parameters<typeof prepareIncognitoSessionTranscriptHydration>[0]["limits"],
    ) {
      disclose();
      return prepareIncognitoSessionTranscriptHydration({
        actor,
        authority,
        target,
        limits,
        signal,
      });
    },
    memoryEntry(
      absPath: string,
      options: Omit<BuildSessionEntryOptions, "onTranscriptMessage"> = {},
    ) {
      const captured = structuredClone(options);
      assertScope(captured);
      return retain(async () => {
        const snapshot = await actor.sessions.history(
          authority,
          {
            type: "session.history.memory-entry",
            input: target,
          },
          signal,
        );
        const { buildSessionEntryFromSnapshot } =
          await import("../../../packages/memory-host-sdk/src/host/session-files.js");
        return buildSessionEntryFromSnapshot(
          absPath,
          { ...captured, ...identity },
          snapshot,
          disclose,
        );
      });
    },
    memoryResetRecall: () =>
      retain(async () => {
        const cutoff = await actor.sessions.history(
          authority,
          {
            type: "session.history.memory-reset-recall",
            input: target,
          },
          signal,
        );
        disclose();
        return cutoff;
      }),
    nativeContext: createCodexSessionContextReader({
      assertCurrent: assertScope,
      read: () =>
        readContextResult(
          actor.sessions.history(
            authority,
            {
              type: "session.history.native-context",
              input: target,
            },
            signal,
          ),
        ),
      validate: ({ version }) =>
        readContextResult(
          actor.sessions.history(
            authority,
            {
              type: "session.history.native-context-current",
              input: { ...target, version },
            },
            signal,
          ),
        ),
      retain,
    }),
  };
}
