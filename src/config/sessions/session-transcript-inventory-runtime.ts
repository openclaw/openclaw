import type {
  SessionTranscriptCorpusArtifact,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import {
  readSessionEntryInWorker,
  withSessionStoreReaderInWorker,
} from "./session-entry-read-runtime.js";
import {
  resolveMemorySessionSince,
  unresolvedMemorySessionTarget,
} from "./session-memory-targets.js";
import type { MemorySessionSelectors } from "./session-memory-targets.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { SessionArchiveInventoryScope } from "./session-transcript-inventory.types.js";

function captureMemoryInventory(scope: SessionArchiveInventoryScope) {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  return captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent });
}

async function readMemoryInventory<T>(
  memory: NonNullable<ReturnType<typeof captureMemoryInventory>>,
  missing: T,
  consume: (binding: SelectedSessionActorStorageBinding) => Promise<T>,
): Promise<T> {
  const selected = memory.binding?.agentId === memory.agentId ? memory.binding : undefined;
  const sessionKey =
    selected?.actor.target.sessionKey ??
    memory.owner?.listSessions(memory.authority)[0]?.target.sessionKey;
  if (!sessionKey) {
    memory.authority.assertCurrent();
    return missing;
  }
  return (
    (await withSessionActorStorage(
      { agentId: memory.agentId, storePath: memory.path, sessionKey, sessionActor: selected },
      {
        authority: memory.authority,
        lifetime: {
          assertCurrent: memory.authority.assertCurrent,
          assertReadable: memory.authority.assertCurrent,
        },
      },
      consume,
    )) ?? missing
  );
}

export async function listSessionTranscriptArchivesInWorker(input: SessionArchiveInventoryScope) {
  const memory = captureMemoryInventory(input);
  if (memory) {
    memory.authority.assertCurrent();
    return [];
  }
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
  prepareArtifacts: () => Promise<readonly SessionTranscriptCorpusArtifact[]>,
) {
  const input = { agentId: scope.normalizedAgentId, storePath: scope.storePath, env: scope.env };
  const memory = captureMemoryInventory(input);
  if (memory) {
    return readMemoryInventory(memory, [], (binding) =>
      binding.actor.storage.read(
        { type: "session.corpus.list", input: { options } },
        binding.authority,
      ),
    );
  }
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, continuation, assertCurrent, onRegistryChange }) => {
      const artifacts = await prepareArtifacts();
      assertCurrent();
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
      }
      const entries = await reader.readCorpusInventory({ scope, options, artifacts, continuation });
      assertCurrent();
      return entries;
    },
    {
      backing: true,
      dataOnly: true,
      capturePhysicalSource: true,
    },
  );
}

export async function resolveMemorySessionTargetsInWorker(input: MemorySessionSelectors) {
  if (!input.sessionIds?.length && !input.hookSources?.length && !input.participants?.length) {
    return [];
  }
  const memory = captureMemoryInventory(input);
  if (memory) {
    resolveMemorySessionSince(input.since);
    return readMemoryInventory(
      memory,
      [...new Set(input.sessionIds ?? [])].map((sessionId) =>
        unresolvedMemorySessionTarget(input.agentId, sessionId),
      ),
      (binding) =>
        binding.actor.storage.read(
          {
            type: "session.memory.targets",
            input: { selectors: { ...input, storePath: memory.path } },
          },
          binding.authority,
        ),
    );
  }
  const scope = {
    ...input,
    env: cloneEnvWithPlatformSemantics(process.env),
    sessionIds: [...new Set(input.sessionIds ?? [])],
    hookSources: [...new Set(input.hookSources ?? [])],
    participants: [...new Set(input.participants ?? [])],
  };
  const storePath = resolveSessionStorePathForScope(scope);
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
