import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import {
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "./session-accessor.sqlite-lifecycle.js";
import { rewindSessionToMessage } from "./session-accessor.sqlite-message-cut.js";
import {
  readSqliteSessionArchivePruning,
  withSqliteSessionPageReclamation,
} from "./session-accessor.sqlite-page-reclamation.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";

const external = vi.hoisted(() => ({
  findWorkspaces: vi.fn(async () => []),
  deleteWorkspace: vi.fn(async () => {}),
  settleReceipt: vi.fn(async (options: { assertCurrent?: () => void }) =>
    options.assertCurrent?.(),
  ),
  prepareReceipt: vi.fn(),
}));
// mock-isolation: Stage external workspace cleanup while the real memory actor owns session lifecycle changes.
vi.mock("../../state/session-repository-workspaces.js", () => ({
  createSessionRepositoryWorkspaceStore: () => ({
    path: "/synthetic/shared.sqlite",
    delete: external.deleteWorkspace,
  }),
  findSessionRepositoryWorkspaces: external.findWorkspaces,
}));
// mock-isolation: Synthetic companion cleanup uses its own admission, without acquiring a shared-state database.
vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ admission: { assertCurrent() {} } }),
}));
// mock-isolation: Control external receipt settlement without opening the durable publication store.
vi.mock("../../state/github-personal-publication-lifecycle.js", () => ({
  preparePersonalGitHubSessionReceiptDeletion: external.prepareReceipt,
}));
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory lifecycle opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory lifecycle allocated a session worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-lifecycle";
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-lifecycle" };
const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
const scope = { agentId: "main", storePath, env, sessionKey };
const authority = { assertCurrent() {}, authorize() {} };
const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
const registries: ReturnType<typeof createEmptyPluginRegistry>[] = [];
beforeEach(() => {
  external.prepareReceipt.mockResolvedValue(external.settleReceipt);
});
afterEach(() => {
  memorySessionActorOwners.reset();
  registries.splice(0).forEach(markPluginRegistryRetired);
  vi.clearAllMocks();
});

async function fixture() {
  const owner = memorySessionActorOwners.get({ agentId: "main", path: storePath });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    {
      assertCurrent() {},
      assertReadable() {},
    },
  );
  readSessionActorStorageResult(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId: "session-1", lifecycleRevision: "revision-1", updatedAt: 1 },
          transcriptEvents: [
            {
              type: "session",
              id: "session-1",
              version: 3,
              cwd: "/synthetic",
              timestamp: "2026-10-11T00:00:00.000Z",
            },
            {
              type: "message",
              id: "user",
              parentId: null,
              message: { role: "user", content: "Question" },
            },
            {
              type: "message",
              id: "answer",
              parentId: "user",
              message: { role: "assistant", content: "Answer", stopReason: "stop" },
            },
          ],
        },
      },
      authority,
    ),
  );
  await actor.release();
  return owner;
}

function harness(failCommit = false) {
  const registry = createEmptyPluginRegistry();
  const companion = { present: true };
  const mutation = {
    commit: vi.fn(() => {
      companion.present = false;
      if (failCommit) {
        throw new Error("Companion commit refused");
      }
    }),
    rollback: vi.fn(() => {
      companion.present = true;
    }),
  };
  const hook: NonNullable<AgentHarness["withSessionDeletion"]> = async (params, run) => {
    params.assertCurrent();
    return run(mutation);
  };
  const record = createPluginRecord({ id: "memory-companion" });
  registry.plugins.push(record);
  registry.agentHarnesses.push({
    pluginId: record.id,
    source: "runtime",
    harness: {
      id: "memory-companion",
      label: "Memory companion",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      withSessionDeletion: hook,
      withSessionContextReset: hook,
    },
  });
  markPluginRegistryActive(registry);
  registries.push(registry);
  return {
    companion,
    mutation,
    run: <T>(work: () => Promise<T>) => withPluginRuntimeRegistryScope(registry, work),
  };
}

describe("memory lifecycle production acquisition", () => {
  it("keeps async reset builders from overwriting intervening actor writes", async () => {
    const owner = await fixture();
    await expect(
      resetSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target,
        buildNextEntry: async ({ currentEntry }) => {
          const writer = await owner.acquireExisting(sessionKey, {
            assertCurrent() {},
            assertReadable() {},
          });
          try {
            readSessionActorStorageResult(
              await writer!.storage!.mutate(
                {
                  type: "session.entry.patch",
                  input: { operation: { kind: "fields", patch: { label: "Concurrent" } } },
                },
                authority,
              ),
            );
          } finally {
            await writer!.release();
          }
          return { ...currentEntry!, sessionId: "session-2", updatedAt: 2 };
        },
      }),
    ).rejects.toThrow(SqliteSessionMutationConflictError);
    expect(owner.readSession(sessionKey, authority)?.entry).toMatchObject({
      sessionId: "session-1",
      label: "Concurrent",
    });
    const result = await resetSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target,
      buildNextEntry: ({ currentEntry }) => {
        currentEntry!.sessionId = "session-2";
        return currentEntry!;
      },
      afterEntryMutation: (mutation, context) => {
        context.assertCurrent();
        expect(mutation.nextEntry).toMatchObject({ sessionId: "session-2", label: "Concurrent" });
      },
    });
    expect(result.previousSessionId).toBe("session-1");
    expect(owner.readSession(sessionKey, authority)?.entry?.sessionId).toBe("session-2");
  });

  it.each([false, true])(
    "settles deletion companions with the memory commit (failure=%s)",
    async (failCommit) => {
      const owner = await fixture();
      const externalOwner = harness(failCommit);
      const remove = () =>
        deleteSessionEntryLifecycle({
          ...scope,
          target,
          archiveTranscript: false,
          expectedSessionId: "session-1",
        });
      await expect(
        externalOwner.run(() =>
          deleteSessionEntryLifecycle({
            ...scope,
            target,
            archiveTranscript: false,
            expectedSessionId: null,
          }),
        ),
      ).resolves.toMatchObject({ deleted: false, expectedEntryMismatch: true });
      expect(externalOwner.mutation.commit).not.toHaveBeenCalled();
      if (failCommit) {
        await expect(externalOwner.run(remove)).rejects.toThrow("Companion commit refused");
        expect(owner.readSession(sessionKey, authority)?.entry?.sessionId).toBe("session-1");
        expect(externalOwner.companion.present).toBe(true);
        expect(externalOwner.mutation.rollback).toHaveBeenCalledOnce();
        expect(external.settleReceipt).not.toHaveBeenCalled();
      } else {
        await expect(externalOwner.run(remove)).resolves.toMatchObject({
          deleted: true,
          deletedSessionId: "session-1",
        });
        expect(owner.readSession(sessionKey, authority)).toBeUndefined();
        expect(externalOwner.companion.present).toBe(false);
        expect(externalOwner.mutation.rollback).not.toHaveBeenCalled();
        expect(external.settleReceipt).toHaveBeenCalledOnce();
      }
    },
  );

  it("rewinds through prepared context companions without native session state", async () => {
    const owner = await fixture();
    const externalOwner = harness();
    await expect(
      externalOwner.run(() => rewindSessionToMessage({ ...scope, entryId: "user" })),
    ).resolves.toMatchObject({ status: "created", editorText: "Question" });
    expect(externalOwner.companion.present).toBe(false);
    expect(externalOwner.mutation.commit).toHaveBeenCalledOnce();
    expect(owner.readSession(sessionKey, authority)?.entry?.sessionId).not.toBe("session-1");
    expect(external.prepareReceipt).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "cleans memory artifacts with real companions and preserves renewed activity (renewed=%s)",
  async (renewed) => {
    const owner = await fixture();
    const externalOwner = harness();
    const nowMs = Date.now() + 60_000;
    if (renewed) {
      external.findWorkspaces.mockImplementationOnce(async () => {
        const writer = await owner.acquireExisting(sessionKey, {
          assertCurrent() {},
          assertReadable() {},
        });
        try {
          readSessionActorStorageResult(
            await writer!.storage!.mutate(
              {
                type: "session.entry.patch",
                input: {
                  operation: { kind: "fields", patch: { updatedAt: nowMs, label: "Still active" } },
                },
              },
              authority,
            ),
          );
        } finally {
          await writer!.release();
        }
        return [];
      });
    }
    const result = await externalOwner.run(() =>
      cleanupSessionLifecycleArtifactsCore({
        agentId: "main",
        storePath,
        env,
        sessionKeySegmentPrefix: "dashboard:incognito-",
        transcriptContentMarker: "Question",
        orphanTranscriptMinAgeMs: 30_000,
        nowMs,
      }),
    );
    expect(result).toEqual({ removedEntries: renewed ? 0 : 1, archivedTranscriptArtifacts: 0 });
    if (renewed) {
      expect(owner.readSession(sessionKey, authority)?.entry).toMatchObject({
        label: "Still active",
        updatedAt: nowMs,
      });
      expect(externalOwner.mutation.commit).not.toHaveBeenCalled();
    } else {
      expect(owner.readSession(sessionKey, authority)).toBeUndefined();
      expect(externalOwner.companion.present).toBe(false);
    }
  },
);

it("excludes absent and resident memory stores from SQLite page reclamation", async () => {
  const input = { agentId: "main", path: storePath, env };
  await expect(readSqliteSessionArchivePruning(input)).resolves.toBeNull();
  await fixture();
  await expect(readSqliteSessionArchivePruning(input)).resolves.toBeNull();
  const reclaim = vi.fn();
  await expect(withSqliteSessionPageReclamation(input, reclaim)).rejects.toThrow(
    "no disk pages or archives",
  );
  expect(reclaim).not.toHaveBeenCalled();
});

it("prunes an unreferenced memory transcript while retaining its current session", async () => {
  const owner = await fixture();
  const nowMs = Date.now() + 60_000;
  await resetSessionEntryLifecycle({
    agentId: "main",
    storePath,
    target,
    buildNextEntry: () => ({ sessionId: "session-2", updatedAt: nowMs }),
  });
  expect(owner.readSessionById("session-1", authority)).toBeDefined();
  await expect(
    cleanupSessionLifecycleArtifactsCore({
      agentId: "main",
      storePath,
      env,
      sessionKeySegmentPrefix: "unrelated-prefix",
      transcriptContentMarker: "Question",
      orphanTranscriptMinAgeMs: 30_000,
      nowMs,
    }),
  ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
  expect(owner.readSessionById("session-1", authority)).toBeUndefined();
  expect(owner.readSession(sessionKey, authority)?.entry?.sessionId).toBe("session-2");
});
