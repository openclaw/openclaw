import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  createSessionEntryWithTranscript,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  resolveSessionEntryCandidateTarget,
  resolveSessionTranscriptRuntimeTarget,
} from "./session-accessor.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { SessionEntry } from "./types.js";

const sessionKey = "agent:main:dashboard:incognito-round-trip";
const authority = { assertCurrent() {}, authorize() {} };
const memoryOwners: Array<{ agentId: string; path: string }> = [];
const makeEntry = (sessionId: string, updatedAt = 1, incognito = true): SessionEntry => ({
  sessionId,
  updatedAt,
  ...(incognito ? { incognito: true } : {}),
});
const create = (
  scope: SessionAccessScope,
  value: SessionEntry,
  options?: Parameters<typeof createSessionEntryWithTranscript>[2],
) => createSessionEntryWithTranscript(scope, () => ({ ok: true, entry: value }), options);
function expectEmpty(...states: OpenClawTestState[]) {
  for (const state of states) {
    expect.soft(fs.readdirSync(state.stateDir, { recursive: true })).toEqual([]);
  }
}
const expectHeader = (scope: SessionAccessScope, sessionId: string, extra = {}) =>
  expect(loadTranscriptEvents({ ...scope, sessionId })).resolves.toEqual([
    expect.objectContaining({ type: "session", id: sessionId, ...extra }),
  ]);
const memoryRead = (binding: SelectedSessionActorStorageBinding) =>
  binding.actor.storage.readCurrent({ type: "session.entry.read", input: {} }, authority);
async function withMemory<T>(
  scope: SessionAccessScope,
  run: (binding: SelectedSessionActorStorageBinding) => Promise<T>,
): Promise<T> {
  const binding = await acquireSessionActorStorage(
    { ...scope, sessionKey: scope.sessionKey.trim() },
    {
      authority,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      create: true,
    },
  );
  if (!binding) {
    throw new Error("Expected memory session actor");
  }
  memoryOwners.push(binding);
  try {
    return await runWithSessionActorStorage(binding, () => run(binding));
  } finally {
    await binding.actor.release();
  }
}
function withIsolatedMemory(
  run: (
    state: OpenClawTestState,
    scope: SessionAccessScope,
    binding: SelectedSessionActorStorageBinding,
  ) => Promise<void>,
  key = sessionKey,
) {
  return withOpenClawTestState({ prefix: "incognito-transcript-", applyEnv: false }, (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: key };
    return withMemory(scope, (binding) => run(state, scope, binding));
  });
}

afterEach(() => {
  for (const options of memoryOwners.splice(0)) {
    memorySessionActorOwners.closeDatabase(options);
  }
  closeOpenClawAgentDatabasesForTest();
});

describe("session creation scope", () => {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;
  const agentId = "secondary";
  const key = "agent:secondary:dashboard:incognito-fresh-session";
  const scopeFor = (env: NodeJS.ProcessEnv | undefined, keyValue = key, storePath?: string) => ({
    agentId,
    env,
    sessionKey: keyValue,
    storePath,
  });

  beforeEach(async () => {
    ambient = await createOpenClawTestState({ prefix: "session-creation-env-ambient-" });
    explicit = await createOpenClawTestState({
      prefix: "session-creation-env-explicit-",
      applyEnv: false,
    });
    setRuntimeConfigSnapshot({});
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await explicit.cleanup();
    await ambient.cleanup();
  });

  it.each(["ambient", "omitted", "sentinel", "durable"] as const)(
    "creates and reloads a secondary transcript without disk state (%s store scope)",
    async (variant) => {
      const state = variant === "ambient" ? ambient : explicit;
      const env = variant === "ambient" ? undefined : explicit.env;
      const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
      const storePath =
        variant === "sentinel"
          ? sentinel
          : variant === "durable"
            ? state.statePath("ignored.sqlite")
            : undefined;
      const scope = scopeFor(env, ` ${key} `, storePath);
      const original = makeEntry("created-incognito");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(ambient.stateDir);
      expect(explicit.stateDir).not.toBe(ambient.stateDir);

      await withMemory(scope, async () => {
        let followed = false;
        const created = await createSessionEntryWithTranscript(
          scope,
          ({ existingEntry, targetEntry, labelInUse }) => {
            expect([existingEntry, targetEntry, labelInUse]).toEqual([undefined, undefined, false]);
            return { ok: true, entry: original };
          },
          {
            cwd: state.workspaceDir,
            label: "unused",
            afterCommitted: async (_entry, source) => {
              source.assertCurrent();
              expect(loadSessionEntry(scope)).toMatchObject(original);
              await Promise.resolve();
              source.assertCurrent();
              expect(loadSessionEntry(scope)).toMatchObject(original);
              followed = true;
            },
          },
        );
        expect(followed).toBe(true);
        expect(created).toMatchObject({
          ok: true,
          entry: { ...original, label: "unused" },
          sessionFile: key,
        });
        expect(memorySessionActorOwners.read({ agentId, path: sentinel })).toMatchObject({
          agentId,
          path: sentinel,
        });
        expectEmpty(explicit, ambient);

        const transcriptScope = { ...scope, sessionKey: key, sessionId: original.sessionId };
        const target = await resolveSessionTranscriptRuntimeTarget(transcriptScope);
        expect(target).toMatchObject({
          agentId,
          sessionId: original.sessionId,
          sessionKey: key,
          storePath: sentinel,
        });
        await expectHeader(transcriptScope, original.sessionId, { cwd: state.workspaceDir });
        const candidate = resolveSessionEntryCandidateTarget({
          agentId,
          env,
          cfg: {},
          candidateKeys: [key],
        });
        expect(candidate).toMatchObject({
          agentId,
          sessionKey: key,
          persisted: true,
          entry: original,
        });

        const updated = { ...original, label: "recreated", updatedAt: 2 };
        await expect(
          createSessionEntryWithTranscript(
            scope,
            ({ existingEntry, targetEntry, labelInUse }) => {
              expect(existingEntry).toMatchObject(original);
              expect(targetEntry).toMatchObject(original);
              expect(labelInUse).toBe(false);
              return { ok: true, entry: updated };
            },
            { label: "recreated" },
          ),
        ).resolves.toMatchObject({ ok: true, sessionFile: key });
        expect(loadSessionEntry(scope)).toMatchObject(updated);
      });
      memorySessionActorOwners.closeDatabase({ agentId, path: sentinel });
      expect(memorySessionActorOwners.read({ agentId, path: sentinel })).toBeUndefined();
      expectEmpty(explicit, ambient);
    },
  );

  it.each([
    ["default", undefined, "agents/secondary/agent/openclaw-agent.sqlite", "secondary"],
    ["exact", "shared.sqlite", "shared.sqlite", "main"],
    ["custom", "custom/sessions.json", "custom/openclaw-agent.secondary.sqlite", "secondary"],
  ] as const)(
    "preserves durable storage and physical ownership (%s store)",
    async (_variant, store, database, physicalOwner) => {
      const databasePath = explicit.statePath(database);
      const scope = scopeFor(
        explicit.env,
        "agent:secondary:dashboard:durable-created",
        store ? explicit.statePath(store) : undefined,
      );
      const original = makeEntry("durable-created", 1, false);
      await expect(create(scope, original)).resolves.toMatchObject({
        ok: true,
        sessionFile: scope.sessionKey,
      });

      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
        status: "owned",
        agentId: physicalOwner,
      });
      expect(listOpenClawRegisteredAgentDatabases({ env: explicit.env })).toEqual([
        expect.objectContaining({ agentId: physicalOwner, path: databasePath }),
      ]);
      expect(fs.existsSync(databasePath)).toBe(true);
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry(scope)).toMatchObject(original);
      await expectHeader(scope, original.sessionId);
      expectEmpty(ambient);
    },
  );

  it("rejects creation atomically when commit authority is revoked", async () => {
    const scope = scopeFor(explicit.env);
    await withMemory(scope, async (binding) => {
      const original = makeEntry("original");
      await create(scope, original);
      await expect(
        create(scope, makeEntry("rejected", 2), {
          commitGuard() {
            throw new Error("creation authority revoked");
          },
        }),
      ).rejects.toThrow("creation authority revoked");
      expect(loadSessionEntry(scope)).toMatchObject(original);
      expect(
        binding.actor.storage.readCurrent(
          { type: "session.entry.readById", input: { sessionId: "rejected" } },
          authority,
        ),
      ).toBeUndefined();
      await expectHeader(scope, "original");
      expectEmpty(explicit);
    });
  });
});

it("round-trips two turns through SessionManager without writing the durable locator", () =>
  withIsolatedMemory(async (state, scope) => {
    const created = await create(scope, makeEntry("incognito-session"));
    expect(created.ok).toBe(true);
    const durableStorePath = path.join(state.workspaceDir, "sessions.json");
    expect(loadSessionEntry({ ...scope, storePath: durableStorePath })?.incognito).toBe(true);
    const target = {
      ...scope,
      sessionId: "incognito-session",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env }),
    };
    const firstTurn = await SessionManager.openAsync(target, state.workspaceDir);
    await firstTurn.appendMessageAsync(makeUserMessage("first question", 1));
    await firstTurn.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "first answer" }] }),
    );
    const secondTurn = await SessionManager.openAsync(target, state.workspaceDir);
    await secondTurn.appendMessageAsync(makeUserMessage("second question", 3));
    const messages = secondTurn.buildSessionContext().messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]).toMatchObject({ content: "first question" });
    expect(messages[2]).toMatchObject({ content: "second question" });
    expect(fs.existsSync(durableStorePath)).toBe(false);
    expectEmpty(state);
  }));

it("automatically archives stale entries, retains their transcripts, and discards them on owner close", () =>
  withIsolatedMemory(async (state, scope, binding) => {
    const now = Date.now();
    const event = {
      id: "archived-event",
      type: "metadata",
      timestamp: new Date(now).toISOString(),
    };
    await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: makeEntry("archived", now - 366 * 24 * 60 * 60 * 1000),
      transcriptEvents: [event],
    }));
    const activeScope = { ...scope, sessionKey: "agent:main:dashboard:incognito-active" };
    const activeActor = await binding.actor.storage.acquire(activeScope.sessionKey);
    try {
      await runWithSessionActorStorage({ ...binding, actor: activeActor }, async () => {
        await create(activeScope, makeEntry("active", now, false));
        const maintenanceConfig = {
          archiveDashboardAfterMs: null,
          highWaterBytes: null,
          maxDiskBytes: null,
          maxEntries: 1,
          mode: "enforce" as const,
          modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
          preserveRecentMs: null,
          pruneAfterMs: 365 * 24 * 60 * 60 * 1000,
          resetArchiveRetentionMs: null,
        };
        await patchSessionEntryCore(activeScope, () => ({ model: "skipped-model" }), {
          maintenanceConfig,
          skipMaintenance: true,
        });
        expect(memoryRead(binding)?.archivedAt).toBeUndefined();
        await patchSessionEntryCore(activeScope, () => ({ model: "test-model" }), {
          maintenanceConfig: { ...maintenanceConfig, mode: "warn" },
        });
        expect(memoryRead(binding)?.archivedAt).toBeUndefined();
        await patchSessionEntryCore(activeScope, () => ({ model: "next-model" }), {
          maintenanceConfig,
        });
      });
    } finally {
      await activeActor.release();
    }
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "archived",
      archivedAt: expect.any(Number),
    });
    const entries = listSessionEntriesCore({
      agentId: "main",
      env: state.env,
      storePath: binding.path,
    });
    expect(entries).toHaveLength(2);
    expect(
      entries
        .filter(({ entry }) => entry.archivedAt === undefined)
        .map(({ sessionKey: entryKey }) => entryKey),
    ).toEqual([activeScope.sessionKey]);
    await expect(loadTranscriptEvents({ ...scope, sessionId: "archived" })).resolves.toEqual([
      event,
    ]);
    memorySessionActorOwners.closeDatabase(binding);
    expect(memorySessionActorOwners.read(binding)).toBeUndefined();
    expect(fs.existsSync(binding.path)).toBe(false);
    expectEmpty(state);
  }, "agent:main:dashboard:incognito-archived"));
