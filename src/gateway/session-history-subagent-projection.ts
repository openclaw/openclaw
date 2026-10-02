import { getRuntimeConfig } from "../config/config.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type {
  SessionHistorySubagentFacts,
  SessionHistorySubagentLookup,
} from "../config/sessions/session-history-types.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createChatHistoryRecoveryProjection } from "./chat-display-projection.core.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import { createPreparedSessionHistorySubagentProjection } from "./session-history-delta-visibility.js";
import { createBoundSessionHistorySubagentProjection } from "./session-history-readonly-reader.js";
import { prepareGatewaySessionStoreReadSources } from "./session-utils-store-sources.js";

/** Bind source addresses and admission once, before an asynchronous history read. */
function prepareSessionHistorySubagentSources(
  currentSource: SessionEntryReadSource,
  options: { env?: NodeJS.ProcessEnv; deferSources?: boolean } = {},
) {
  const env = options.env ?? process.env;
  const context = captureOpenClawStateWorkerContext({ env });
  const sourceReads = prepareGatewaySessionStoreReadSources({
    cfg: getRuntimeConfig(),
    currentSource,
    env,
    registryPath: context.admission.databasePath,
    deferSources: options.deferSources,
  });
  return {
    stateDatabase: {
      path: context.admission.databasePath,
      environment: context.environment,
    },
    get sourceDatabases() {
      return sourceReads.sources;
    },
    assertCurrent: () => {
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      sourceReads.assertCurrent();
    },
  };
}

/** Bind host-owned stores and retain their admission for one display operation. */
function createProcessHeldSessionHistorySubagentProjection(
  scope: SessionTranscriptReadScope,
  options: { deferSources?: boolean } = {},
): SubagentCoordinationDisplayResolver {
  const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
  const sources = prepareSessionHistorySubagentSources(
    { agentId: databaseOptions.agentId, path: resolveOpenClawAgentSqlitePath(databaseOptions) },
    options,
  );
  const bound = createBoundSessionHistorySubagentProjection(
    (read) => withCurrentProjectionSnapshot(scope, read, { readOnly: true }),
    sources.stateDatabase,
    () => sources.sourceDatabases,
  );
  const assertCurrent = sources.assertCurrent;
  const readCurrent = <T>(read: () => T): T => {
    assertCurrent();
    const result = read();
    assertCurrent();
    return result;
  };
  return {
    assertCurrent,
    isSubagentSession: (sessionKey) => readCurrent(() => bound.isSubagentSession(sessionKey)),
    isSubagentRunMessage: (runId, messageSeq) =>
      readCurrent(() => bound.isSubagentRunMessage(runId, messageSeq)),
  };
}

/** Disk-backed visibility is prepared in the same admitted worker as paged history. */
export function createSessionHistorySubagentProjection(
  scope: SessionTranscriptReadScope,
): SubagentCoordinationDisplayResolver {
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    (scope.storePath &&
      isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
        env: scope.env,
      }))
  ) {
    return createProcessHeldSessionHistorySubagentProjection(scope);
  }
  const target = {
    ...bindSessionTranscriptStoreScope(scope),
    sessionEntry: scope.sessionEntry ? { sessionId: scope.sessionEntry.sessionId } : undefined,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const context = captureOpenClawStateWorkerContext({ env: target.env });
  let assertPreparedCurrent: (() => void) | undefined;
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    assertPreparedCurrent?.();
  };
  const facts: SessionHistorySubagentFacts = { sessions: [], runMessages: [] };
  const prepared = new Set<string>();
  let projection = createPreparedSessionHistorySubagentProjection(facts, assertCurrent);
  return {
    assertCurrent,
    async prepare(messages) {
      assertCurrent();
      const lookups = new Map<string, SessionHistorySubagentLookup>();
      const remember = (lookup: SessionHistorySubagentLookup) => {
        const key = JSON.stringify(lookup);
        if (!prepared.has(key)) {
          lookups.set(key, lookup);
        }
        return false;
      };
      const recording: SubagentCoordinationDisplayResolver = {
        isSubagentSession: (sessionKey) => remember({ kind: "session", sessionKey }),
        isSubagentRunMessage: (runId, messageSeq) =>
          messageSeq === undefined ? false : remember({ kind: "run", runId, messageSeq }),
      };
      for (const message of messages) {
        // Independent rows cover every lookup even when later page composition changes.
        createChatHistoryRecoveryProjection({ subagentCoordination: recording }).append([message]);
      }
      if (lookups.size === 0) {
        return;
      }
      const { readSessionHistoryPageInWorker } =
        await import("../config/sessions/session-history-worker-runtime.js");
      assertCurrent();
      const result = await readSessionHistoryPageInWorker({
        kind: "subagent-visibility",
        params: { target, lookups: [...lookups.values()] },
      });
      assertCurrent();
      result.assertCurrent();
      assertPreparedCurrent = result.assertCurrent;
      facts.sessions.push(...result.facts.sessions);
      facts.runMessages.push(...result.facts.runMessages);
      for (const key of lookups.keys()) {
        prepared.add(key);
      }
      projection = createPreparedSessionHistorySubagentProjection(facts, assertCurrent);
    },
    isSubagentSession: (sessionKey) => projection.isSubagentSession(sessionKey),
    isSubagentRunMessage: (runId, messageSeq) => {
      assertCurrent();
      return messageSeq === undefined ? false : projection.isSubagentRunMessage(runId, messageSeq);
    },
  };
}
