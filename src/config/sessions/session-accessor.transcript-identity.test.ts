import { renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { AgentDatabaseRegistryChangedError } from "../../state/openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import * as transcriptTargets from "./session-accessor.transcript-target.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionStoreTarget } from "./session-store-target-runtime.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("transcript turn physical identity", () => {
  const fixture = useTempSessionsFixture("openclaw-transcript-identity-");
  const sessionId = "selected-window";
  const scope = (sessionKey = "global") => ({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: fixture.storePath(),
  });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = { role: "user", content: "Selected conversation" };
  const persist = (sessionKey: string) =>
    persistSessionTranscriptTurn(scope(sessionKey), {
      expectedSessionId: sessionId,
      messages: [{ message }],
      updateMode: "none",
    });
  const keys = () =>
    database().db.prepare("SELECT session_key FROM session_nodes ORDER BY session_key").all();
  const retainWindowOnly = () => {
    database().db.prepare("UPDATE session_nodes SET entry_json = '{}'").run();
    database().db.prepare("UPDATE session_nodes SET entry_valid = -1").run();
  };

  afterEach(() => vi.restoreAllMocks());

  function pauseTargetSelection() {
    const selected = createDeferred();
    const resume = createDeferred();
    const resolve = transcriptTargets.resolveSessionTranscriptRuntimeTarget;
    vi.spyOn(transcriptTargets, "resolveSessionTranscriptRuntimeTarget").mockImplementationOnce(
      async (...args) => {
        const target = await resolve(...args);
        selected.resolve();
        await resume.promise;
        return target;
      },
    );
    return { selected: selected.promise, resume: resume.resolve };
  }

  it.runIf(process.platform !== "win32")(
    "rejects a replaced database before returning a runtime target",
    async () => {
      replaceSessionEntrySync(scope(), { sessionId, updatedAt: 1 });
      const original = database();
      const replacement = openOpenClawAgentDatabase({
        agentId: "main",
        path: `${original.path}.replacement`,
      });
      await closeOpenClawAgentDatabaseByPathAsync(original.path, original.agentId);
      await closeOpenClawAgentDatabaseByPathAsync(replacement.path, replacement.agentId);
      const run = historyLane.pool.run.bind(historyLane.pool);
      let replaced = false;
      vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (
          reply.ok &&
          typeof reply.value !== "boolean" &&
          !Array.isArray(reply.value) &&
          reply.value.kind === "session-runtime-target"
        ) {
          renameSync(original.path, `${original.path}.retired`);
          renameSync(replacement.path, original.path);
          replaced = true;
        }
        return reply;
      });
      await expect(
        transcriptTargets.resolveSessionTranscriptRuntimeTarget(scope(), undefined, {
          keyFormat: "agent-qualified",
        }),
      ).rejects.toThrow(/identity/i);
      expect(replaced).toBe(true);
    },
  );

  it.each(["same owner", "different owner", "state retirement"] as const)(
    "keeps post-selection first registration bound to its %s",
    async (change) => {
      const target = { ...scope(), storePath: `${fixture.storePath()}.custom.json` };
      const databaseOptions = toDatabaseOptions(resolveSqliteScope(target));
      const shared = openOpenClawStateDatabase();
      const run = historyLane.pool.run.bind(historyLane.pool);
      let reads = 0;
      vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (
          reply.ok &&
          typeof reply.value !== "boolean" &&
          !Array.isArray(reply.value) &&
          reply.value.kind === "session-runtime-target"
        ) {
          reads++;
          openOpenClawAgentDatabase({
            ...databaseOptions,
            agentId: change === "different owner" ? "other" : "main",
          });
          if (change === "state retirement") {
            await closeOpenClawStateDatabaseByPathAsync(shared.path);
            openOpenClawStateDatabase();
          }
        }
        return reply;
      });
      const pending = transcriptTargets.resolveSessionTranscriptRuntimeTarget(target);
      if (change === "same owner") {
        await expect(pending).resolves.toMatchObject(target);
      } else if (change === "different owner") {
        await expect(pending).rejects.toThrow("registry changed");
      } else {
        await expect(pending).rejects.toMatchObject({
          code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
        });
      }
      expect(reads).toBe(1);
    },
  );

  it.runIf(process.platform !== "win32").each(["pending", "committed"] as const)(
    "rejects aliased replacement after accepting the first %s registration",
    async (phase) => {
      const storePath = `${fixture.storePath()}.custom.json`;
      const aliasDirectory = `${fixture.sessionsDir()}-alias`;
      symlinkSync(fixture.sessionsDir(), aliasDirectory, "dir");
      const aliasStorePath = path.join(aliasDirectory, path.basename(storePath));
      const staging = ["first", "replacement"].map((name) =>
        openOpenClawAgentDatabase({
          agentId: "main",
          path: `${fixture.storePath()}.${name}.sqlite`,
        }),
      );
      for (const source of staging) {
        await closeOpenClawAgentDatabaseByPathAsync(source.path, source.agentId);
      }
      let acceptedFirst = false;
      await expect(
        withSessionStoreTarget(
          {
            agentId: "main",
            storePath,
            env: process.env,
            candidates: [
              ...captureSessionStoreReadCandidates(storePath),
              ...captureSessionStoreReadCandidates(aliasStorePath),
            ],
          },
          async (target, owner) => {
            const registerFirst = () => {
              renameSync(staging[0]!.path, target.database.path);
              registerOpenClawAgentDatabase(target.database);
              owner.assertCurrent();
              acceptedFirst = true;
            };
            const replace = () => {
              renameSync(target.database.path, `${target.database.path}.retired`);
              renameSync(staging[1]!.path, target.database.path);
              registerOpenClawAgentDatabase(target.database);
              owner.assertCurrent();
            };
            if (phase === "pending") {
              runOpenClawStateWriteTransaction(() => {
                registerFirst();
                replace();
              });
            } else {
              registerFirst();
              replace();
            }
          },
        ),
      ).rejects.toThrow(AgentDatabaseRegistryChangedError);
      expect(acceptedFirst).toBe(true);
    },
  );

  it.each([
    { stored: "unknown", requested: "agent:main:unknown", mainKey: undefined },
    { stored: "agent:main:main", requested: "agent:main:main", mainKey: "custom" },
  ])(
    "preserves the physical row $stored when writing $requested",
    async ({ stored, requested, mainKey }) => {
      replaceSessionEntrySync(scope(stored), { sessionId, updatedAt: 1 });
      if (mainKey) {
        setCanonicalSqliteSessionMainKey(database(), mainKey);
      }
      await expect(
        persistSessionTranscriptTurn(scope(requested), {
          ...(mainKey ? { config: { session: { mainKey } } } : {}),
          expectedSessionId: sessionId,
          messages: [{ message }],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 1 });
      expect(keys()).toEqual([{ session_key: stored }]);
      expect(loadTranscriptEventsSync(scope(stored))).toContainEqual(
        expect.objectContaining({ type: "message", message }),
      );
      if (!mainKey) {
        expect(loadSessionEntryReadOnly(scope(stored))?.sessionId).toBe(sessionId);
        expect(loadSessionEntryReadOnly(scope(requested))).toBeUndefined();
      }
    },
  );

  it.each(["entry", "retained window"])(
    "refuses a competing qualified %s before appending through the selected SID",
    async (kind) => {
      replaceSessionEntrySync(scope(), { sessionId, updatedAt: 1 });
      replaceSessionEntrySync(scope("agent:main:global"), {
        sessionId: "competing-window",
        updatedAt: 1,
      });
      if (kind === "retained window") {
        database()
          .db.prepare("UPDATE session_nodes SET entry_json = '{}' WHERE session_key = ?")
          .run("agent:main:global");
        database()
          .db.prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
          .run("agent:main:global");
      }
      expect(loadSessionEntryReadOnly(scope())?.sessionId).toBe(sessionId);
      await expect(persist("agent:main:global")).rejects.toMatchObject({
        code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
      });
      expect(loadTranscriptEventsSync(scope())).toEqual([]);
      expect(keys()).toEqual([{ session_key: "agent:main:global" }, { session_key: "global" }]);
    },
  );

  it.each<{
    change: "revision" | "delete" | "appears" | "disappears";
    revision?: string;
    expected?: string;
  }>([
    { change: "revision", revision: "original" },
    { change: "revision" },
    { change: "revision", revision: "original", expected: "successor" },
    { change: "delete" },
    { change: "appears" },
    { change: "disappears" },
  ])(
    "rejects a changed $change precondition (revision=$revision, fence=$expected)",
    async ({ change, revision, expected }) => {
      const entry = { sessionId, updatedAt: 1, lifecycleRevision: revision };
      if (change !== "appears") {
        replaceSessionEntrySync(scope(), entry);
      }
      const creation = change === "appears" || change === "disappears";
      const selection = pauseTargetSelection();
      const pending = persistSessionTranscriptTurn(
        scope(creation ? "global" : "agent:main:global"),
        {
          ...(change === "delete" ? {} : { expectedSessionId: sessionId }),
          ...(creation ? { initialSessionEntry: entry } : {}),
          expectedLifecycleRevision: expected,
          messages: [{ message }],
          updateMode: "none",
        },
      );
      try {
        await awaitGateBeforeSettlement(
          selection.selected,
          pending,
          "Transcript turn settled before selecting its target",
        );
        if (change === "revision") {
          replaceSessionEntrySync(scope(), {
            sessionId,
            updatedAt: 2,
            lifecycleRevision: "successor",
          });
        } else if (change === "appears") {
          replaceSessionEntrySync(scope(), entry);
        } else {
          retainWindowOnly();
        }
      } finally {
        selection.resume();
      }
      await expect(pending).resolves.toMatchObject({
        rejectedReason: "session-rebound",
        appendedCount: 0,
      });
      if (change === "revision") {
        expect(loadSessionEntryReadOnly(scope())?.lifecycleRevision).toBe("successor");
      } else if (change === "delete") {
        expect(loadSessionEntryReadOnly(scope())).toBeUndefined();
      }
      expect(loadTranscriptEventsSync(scope())).toEqual([]);
    },
  );

  it("does not retarget the selected spelling even when SID and revision survive a move", async () => {
    const entry = { sessionId, updatedAt: 1, lifecycleRevision: "unchanged" };
    replaceSessionEntrySync(scope(), entry);
    const selection = pauseTargetSelection();
    const outcome = persist("agent:main:global").then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(
        selection.selected,
        outcome,
        "Transcript turn settled before selecting its target",
      );
      await applySessionEntryCanonicalReplacements({
        agentId: "main",
        storePath: fixture.storePath(),
        sessionKeys: ["global", "agent:main:global"],
        skipMaintenance: true,
        update: () => ({
          result: undefined,
          replacements: [
            { sessionKey: "agent:main:global", previousSessionKeys: ["global"], entry },
          ],
        }),
      });
    } finally {
      selection.resume();
      await outcome;
    }
    expect(await outcome).toMatchObject({
      error: { code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" },
    });
    expect(keys()).toEqual([{ session_key: "agent:main:global" }]);
    expect(loadTranscriptEventsSync(scope("agent:main:global"))).toEqual([]);
  });
});
