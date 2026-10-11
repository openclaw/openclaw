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
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
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

const sessionKey = "agent:main:dashboard:incognito-round-trip";
const authority = { assertCurrent() {}, authorize() {} };
const memoryOwners: Array<{ agentId: string; path: string }> = [];
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
  if (!binding) throw new Error("Expected memory session actor");
  memoryOwners.push(binding);
  try {
    return await runWithSessionActorStorage(binding, () => run(binding));
  } finally {
    await binding.actor.release();
  }
}

afterEach(() => {
  for (const options of memoryOwners.splice(0)) memorySessionActorOwners.closeDatabase(options);
  closeOpenClawAgentDatabasesForTest();
});

describe("session creation scope", () => {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;
  const agentId = "secondary";
  const key = "agent:secondary:dashboard:incognito-fresh-session";

  beforeEach(async () => {
    ambient = await createOpenClawTestState({ prefix: "session-creation-env-ambient-" });
    explicit = await createOpenClawTestState({
      prefix: "session-creation-env-explicit-",
      applyEnv: false,
    });
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
      const scope = {
        agentId,
        env,
        sessionKey: ` ${key} `,
        ...(variant === "sentinel"
          ? { storePath: sentinel }
          : variant === "durable"
            ? { storePath: state.statePath("ignored.sqlite") }
            : {}),
      };
      const entry = { incognito: true as const, sessionId: "created-incognito", updatedAt: 1 };
      expect(process.env.OPENCLAW_STATE_DIR).toBe(ambient.stateDir);
      expect(explicit.stateDir).not.toBe(ambient.stateDir);

      await withMemory(scope, async () => {
        const created = await createSessionEntryWithTranscript(
          scope,
          ({ existingEntry, targetEntry, labelInUse }) => {
            expect(existingEntry).toBeUndefined();
            expect(targetEntry).toBeUndefined();
            expect(labelInUse).toBe(false);
            return { ok: true, entry };
          },
          { cwd: state.workspaceDir, label: "unused" },
        );
        expect(created).toMatchObject({
          ok: true,
          entry: { ...entry, label: "unused" },
          sessionFile: key,
        });
        expect(memorySessionActorOwners.read({ agentId, path: sentinel })).toMatchObject({
          agentId,
          path: sentinel,
        });
        expect.soft(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
        expect.soft(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);

        const transcriptScope = { ...scope, sessionKey: key, sessionId: entry.sessionId };
        await expect(resolveSessionTranscriptRuntimeTarget(transcriptScope)).resolves.toMatchObject(
          {
            agentId,
            sessionId: entry.sessionId,
            sessionKey: key,
            storePath: sentinel,
          },
        );
        await expect(loadTranscriptEvents(transcriptScope)).resolves.toEqual([
          expect.objectContaining({
            type: "session",
            id: entry.sessionId,
            cwd: state.workspaceDir,
          }),
        ]);
        expect(
          resolveSessionEntryCandidateTarget({
            agentId,
            env,
            cfg: {},
            candidateKeys: [key],
          }),
        ).toMatchObject({ agentId, sessionKey: key, persisted: true, entry });

        const updated = { ...entry, label: "recreated", updatedAt: 2 };
        await expect(
          createSessionEntryWithTranscript(
            scope,
            ({ existingEntry, targetEntry, labelInUse }) => {
              expect(existingEntry).toMatchObject(entry);
              expect(targetEntry).toMatchObject(entry);
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
      expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
      expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    },
  );

  it.each(["default", "exact", "custom"] as const)(
    "preserves durable storage and physical ownership (%s store)",
    async (variant) => {
      const storePath =
        variant === "default"
          ? undefined
          : explicit.statePath(variant === "exact" ? "shared.sqlite" : "custom/sessions.json");
      const databasePath =
        variant === "default"
          ? explicit.statePath("agents/secondary/agent/openclaw-agent.sqlite")
          : variant === "exact"
            ? explicit.statePath("shared.sqlite")
            : explicit.statePath("custom/openclaw-agent.secondary.sqlite");
      const physicalOwner = variant === "exact" ? "main" : agentId;
      const scope = {
        agentId,
        env: explicit.env,
        sessionKey: "agent:secondary:dashboard:durable-created",
        storePath,
      };
      const entry = { sessionId: "durable-created", updatedAt: 1 };
      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: true, entry })),
      ).resolves.toMatchObject({ ok: true, sessionFile: scope.sessionKey });

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
      expect(loadSessionEntry(scope)).toMatchObject(entry);
      await expect(loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })).resolves.toEqual(
        [expect.objectContaining({ type: "session", id: entry.sessionId })],
      );
      expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    },
  );

  it("rejects creation atomically when commit authority is revoked", async () => {
    const scope = { agentId, env: explicit.env, sessionKey: key };
    await withMemory(scope, async (binding) => {
      const original = { incognito: true as const, sessionId: "original", updatedAt: 1 };
      await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry: original }));
      await expect(
        createSessionEntryWithTranscript(
          scope,
          () => ({
            ok: true,
            entry: { ...original, sessionId: "rejected", updatedAt: 2 },
          }),
          {
            commitGuard() {
              throw new Error("creation authority revoked");
            },
          },
        ),
      ).rejects.toThrow("creation authority revoked");
      expect(loadSessionEntry(scope)).toMatchObject(original);
      expect(
        binding.actor.storage.readCurrent(
          { type: "session.entry.readById", input: { sessionId: "rejected" } },
          authority,
        ),
      ).toBeUndefined();
      await expect(loadTranscriptEvents({ ...scope, sessionId: "original" })).resolves.toEqual([
        expect.objectContaining({ type: "session", id: "original" }),
      ]);
      expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
    });
  });
});

describe("incognito transcript access", () => {
  it("round-trips two turns through SessionManager without writing the durable locator", async () => {
    const state = await createOpenClawTestState({ prefix: "incognito-turns-", applyEnv: false });
    const scope = { agentId: "main", env: state.env, sessionKey };
    try {
      await withMemory(scope, async () => {
        const created = await createSessionEntryWithTranscript(scope, () => ({
          ok: true,
          entry: { sessionId: "incognito-session", updatedAt: 1, incognito: true },
        }));
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
        expect(fs.readdirSync(state.stateDir, { recursive: true })).toEqual([]);
      });
    } finally {
      await state.cleanup();
    }
  });

  it("automatically archives stale entries, retains their transcripts, and discards them on owner close", async () => {
    const state = await createOpenClawTestState({ prefix: "incognito-archive-", applyEnv: false });
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:dashboard:incognito-archived",
    };
    const now = Date.now();
    const event = {
      id: "archived-event",
      type: "metadata",
      timestamp: new Date(now).toISOString(),
    };
    try {
      await withMemory(scope, async (binding) => {
        await createSessionEntryWithTranscript(scope, () => ({
          ok: true,
          entry: {
            sessionId: "archived",
            updatedAt: now - 366 * 24 * 60 * 60 * 1000,
            incognito: true,
          },
          transcriptEvents: [event],
        }));
        const activeScope = { ...scope, sessionKey: "agent:main:dashboard:incognito-active" };
        const activeActor = await binding.actor.storage.acquire(activeScope.sessionKey);
        try {
          await runWithSessionActorStorage({ ...binding, actor: activeActor }, async () => {
            await createSessionEntryWithTranscript(activeScope, () => ({
              ok: true,
              entry: { sessionId: "active", updatedAt: now },
            }));
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
            expect(
              binding.actor.storage.readCurrent(
                { type: "session.entry.read", input: {} },
                authority,
              )?.archivedAt,
            ).toBeUndefined();
            await patchSessionEntryCore(activeScope, () => ({ model: "test-model" }), {
              maintenanceConfig: { ...maintenanceConfig, mode: "warn" },
            });
            expect(
              binding.actor.storage.readCurrent(
                { type: "session.entry.read", input: {} },
                authority,
              )?.archivedAt,
            ).toBeUndefined();
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
            .map(({ sessionKey }) => sessionKey),
        ).toEqual([activeScope.sessionKey]);
        await expect(loadTranscriptEvents({ ...scope, sessionId: "archived" })).resolves.toEqual([
          event,
        ]);
        memorySessionActorOwners.closeDatabase(binding);
        expect(memorySessionActorOwners.read(binding)).toBeUndefined();
        expect(fs.existsSync(binding.path)).toBe(false);
        expect(fs.readdirSync(state.stateDir, { recursive: true })).toEqual([]);
      });
    } finally {
      await state.cleanup();
    }
  });
});
