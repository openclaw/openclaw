import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
  withSessionActorStorage,
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
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
async function withMemory(
  scope: SessionAccessScope,
  run: (binding: SelectedSessionActorStorageBinding) => Promise<void>,
) {
  let acquired = false;
  await withSessionActorStorage(
    { ...scope, sessionKey: scope.sessionKey.trim() },
    {
      authority,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      create: true,
    },
    (binding) => {
      acquired = true;
      memoryOwners.push(binding);
      return run(binding);
    },
  );
  expect(acquired).toBe(true);
}

afterEach(async () => {
  for (const options of memoryOwners.splice(0)) {
    memorySessionActorOwners.closeDatabase(options);
  }
  closeOpenClawAgentDatabasesForTest();
  await explicit.cleanup();
  await ambient.cleanup();
});

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

it.each(["ambient", "omitted", "sentinel", "durable"] as const)(
  "creates and reloads an incognito transcript (%s scope)",
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
      const createChecked = async (value: SessionEntry, label: string, previous?: SessionEntry) => {
        let followed = false;
        const result = await createSessionEntryWithTranscript(
          scope,
          (snapshot) => {
            const expected = previous ? expect.objectContaining(previous) : undefined;
            expect(snapshot).toMatchObject({
              existingEntry: expected,
              targetEntry: expected,
              labelInUse: false,
            });
            return { ok: true, entry: value };
          },
          {
            cwd: state.workspaceDir,
            label,
            afterCommitted: async (_entry, source) => {
              source.assertCurrent();
              expect(loadSessionEntry(scope)).toMatchObject(value);
              await Promise.resolve();
              source.assertCurrent();
              expect(loadSessionEntry(scope)).toMatchObject(value);
              followed = true;
            },
          },
        );
        expect(followed).toBe(true);
        expect(result).toMatchObject({ ok: true, entry: { ...value, label }, sessionFile: key });
      };
      await createChecked(original, "unused");
      expect(memorySessionActorOwners.read({ agentId, path: sentinel })).toMatchObject({
        agentId,
        path: sentinel,
      });
      expectEmpty(explicit, ambient);

      const transcriptScope = { ...scope, sessionKey: key, sessionId: original.sessionId };
      expect(await resolveSessionTranscriptRuntimeTarget(transcriptScope)).toMatchObject({
        agentId,
        sessionId: original.sessionId,
        sessionKey: key,
        storePath: sentinel,
      });
      await expectHeader(transcriptScope, original.sessionId, { cwd: state.workspaceDir });
      expect(
        resolveSessionEntryCandidateTarget({ agentId, env, cfg: {}, candidateKeys: [key] }),
      ).toMatchObject({
        agentId,
        sessionKey: key,
        persisted: true,
        entry: original,
      });

      const updated = { ...original, label: "recreated", updatedAt: 2 };
      await createChecked(updated, "recreated", original);
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
  "preserves durable physical ownership (%s store)",
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

it("rolls back creation after commit authority is revoked", async () => {
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
it("reopens incognito turns without writing a durable locator", async () => {
  const scope = { agentId: "main", env: explicit.env, sessionKey };
  await withMemory(scope, async () => {
    await create(scope, makeEntry("incognito-session"));
    const durableStorePath = path.join(explicit.workspaceDir, "sessions.json");
    expect(loadSessionEntry({ ...scope, storePath: durableStorePath })?.incognito).toBe(true);
    const target = {
      ...scope,
      sessionId: "incognito-session",
      storePath: resolveSessionStorePathCore(undefined, scope),
    };
    const firstTurn = await SessionManager.openAsync(target, explicit.workspaceDir);
    await firstTurn.appendMessageAsync(makeUserMessage("first question", 1));
    await firstTurn.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "first answer" }] }),
    );
    const secondTurn = await SessionManager.openAsync(target, explicit.workspaceDir);
    await secondTurn.appendMessageAsync(makeUserMessage("second question", 3));
    expect(secondTurn.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "first question" },
      { role: "assistant" },
      { role: "user", content: "second question" },
    ]);
    expect(fs.existsSync(durableStorePath)).toBe(false);
    expectEmpty(explicit);
  });
});

it("retains archived incognito transcripts until owner close", async () => {
  const scope = {
    agentId: "main",
    env: explicit.env,
    sessionKey: "agent:main:dashboard:incognito-archived",
  };
  await withMemory(scope, async (binding) => {
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
        const maintenanceConfig = resolveMaintenanceConfigFromInput({
          archiveDashboardAfter: false,
          maxDiskBytes: false,
          maxEntries: 1,
          pruneAfter: "365d",
        });
        for (const mode of ["skip", "warn", "enforce"] as const) {
          await patchSessionEntryCore(activeScope, () => ({ model: mode }), {
            maintenanceConfig: { ...maintenanceConfig, mode: mode === "warn" ? "warn" : "enforce" },
            skipMaintenance: mode === "skip",
          });
          if (mode !== "enforce") {
            expect(memoryRead(binding)?.archivedAt).toBeUndefined();
          }
        }
      });
    } finally {
      await activeActor.release();
    }
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "archived",
      archivedAt: expect.any(Number),
    });
    const entries = listSessionEntriesCore({ ...scope, storePath: binding.path });
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
    expectEmpty(explicit);
  });
});
