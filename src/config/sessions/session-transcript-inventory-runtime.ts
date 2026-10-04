import type {
  SessionTranscriptCorpusArtifact,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { listSessionTranscriptArchivesReadOnly } from "./session-accessor.sqlite-history.js";
import {
  readSessionEntryInWorker,
  withSessionStoreReaderInWorker,
} from "./session-entry-read-runtime.js";
import { readMemorySessionTargets } from "./session-memory-targets.js";
import type { MemorySessionSelectors } from "./session-memory-targets.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { SessionArchiveInventoryScope } from "./session-transcript-inventory.types.js";

export async function listSessionTranscriptArchivesInWorker(input: SessionArchiveInventoryScope) {
  const scope = {
    ...input,
    env: cloneEnvWithPlatformSemantics(input.env ?? process.env),
    sessionIds: [...new Set(input.sessionIds ?? [])],
    archiveNames: [...new Set(input.archiveNames ?? [])],
  };
  if (scope.sessionIds.length === 0 && scope.archiveNames.length === 0) {
    return [];
  }
  const storePath = resolveSessionStorePathForScope(scope);
  if (
    isIncognitoOpenClawAgentSqlitePath(storePath, { ...scope, agentId: scope.agentId ?? "main" })
  ) {
    return listSessionTranscriptArchivesReadOnly({ ...scope, storePath });
  }
  return withSessionStoreReaderInWorker(
    { ...scope, storePath },
    async ({ reader, database, logicalAgentId, assertCurrent }) => {
      const archives = await reader.readArchiveInventory({
        ...scope,
        agentId: logicalAgentId,
        storePath: database.path,
      });
      assertCurrent();
      return archives;
    },
    { backing: true, dataOnly: true },
  );
}

export async function readSessionTranscriptCorpusInWorker(
  scope: SessionTranscriptCorpusScope,
  options: SessionTranscriptCorpusOptions,
  artifacts: readonly SessionTranscriptCorpusArtifact[],
) {
  const input = { agentId: scope.normalizedAgentId, storePath: scope.storePath, env: scope.env };
  return withSessionStoreReaderInWorker(
    input,
    async ({
      reader,
      database,
      continuation,
      assertCurrent,
      onRegistryChange,
      revalidateTarget,
    }) => {
      if (options.readOnly !== true && !continuation) {
        // Default corpus discovery retains its historical writable-open admission.
        await readSessionEntryInWorker(
          {
            agentId: database.agentId,
            storePath: database.path,
            env: database.env,
            sessionKey: "",
          },
          assertCurrent,
          onRegistryChange,
        );
        await revalidateTarget?.();
        assertCurrent();
      }
      const entries = await reader.readCorpusInventory({ scope, options, artifacts, continuation });
      assertCurrent();
      return entries;
    },
    { backing: true, dataOnly: true },
  );
}

export async function resolveMemorySessionTargetsInWorker(input: MemorySessionSelectors) {
  const scope = {
    ...input,
    env: cloneEnvWithPlatformSemantics(process.env),
    sessionIds: [...new Set(input.sessionIds ?? [])],
    hookSources: [...new Set(input.hookSources ?? [])],
    participants: [...new Set(input.participants ?? [])],
  };
  if (!scope.sessionIds.length && !scope.hookSources.length && !scope.participants.length) {
    return [];
  }
  const storePath = resolveSessionStorePathForScope(scope);
  if (isIncognitoOpenClawAgentSqlitePath(storePath, scope)) {
    return readMemorySessionTargets({ ...scope, storePath });
  }
  return withSessionStoreReaderInWorker(
    { ...scope, storePath },
    async ({ reader, database, logicalAgentId, continuation, assertCurrent }) => {
      const targets = await reader.readMemorySessionTargets({
        params: { ...scope, agentId: logicalAgentId, storePath: database.path },
        continuation,
      });
      assertCurrent();
      return targets;
    },
    { backing: true, dataOnly: true },
  );
}
