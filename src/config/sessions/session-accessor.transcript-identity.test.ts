import { renameSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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

  it.runIf(process.platform !== "win32").each([undefined, "agent-qualified"] as const)(
    "rejects a replaced database before returning a runtime target (%s)",
    async (keyFormat) => {
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
        transcriptTargets.resolveSessionTranscriptRuntimeTarget(scope(), undefined, { keyFormat }),
      ).rejects.toThrow(/identity/i);
      expect(replaced).toBe(true);
    },
  );

  it("writes the qualified unknown identity into its existing raw physical row", async () => {
    const raw = "unknown";
    replaceSessionEntrySync(scope(raw), { sessionId, updatedAt: 1 });
    await expect(persist(`agent:main:${raw}`)).resolves.toMatchObject({ appendedCount: 1 });
    expect(keys()).toEqual([{ session_key: raw }]);
    expect(loadTranscriptEventsSync(scope(raw))).toContainEqual(
      expect.objectContaining({ type: "message", message }),
    );
    expect(loadSessionEntryReadOnly(scope(raw))?.sessionId).toBe(sessionId);
    expect(loadSessionEntryReadOnly(scope(`agent:main:${raw}`))).toBeUndefined();
  });

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

  it("keeps a fully qualified literal main key when the configured main alias changes", async () => {
    const literal = scope("agent:main:main");
    replaceSessionEntrySync(literal, { sessionId, updatedAt: 1 });
    setCanonicalSqliteSessionMainKey(database(), "custom");
    await expect(
      persistSessionTranscriptTurn(literal, {
        config: { session: { mainKey: "custom" } },
        expectedSessionId: sessionId,
        messages: [{ message }],
        updateMode: "none",
      }),
    ).resolves.toMatchObject({ appendedCount: 1 });
    expect(keys()).toEqual([{ session_key: literal.sessionKey }]);
    expect(loadTranscriptEventsSync(literal)).toContainEqual(
      expect.objectContaining({ type: "message", message }),
    );
  });

  it.each([
    { revision: "original", expected: undefined },
    { revision: undefined, expected: undefined },
    { revision: "original", expected: "successor" },
  ])(
    "retains the initially selected revision $revision with caller fence $expected",
    async (row) => {
      replaceSessionEntrySync(scope(), {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: row.revision,
      });
      const selection = pauseTargetSelection();
      const pending = persistSessionTranscriptTurn(scope("agent:main:global"), {
        expectedSessionId: sessionId,
        expectedLifecycleRevision: row.expected,
        messages: [{ message }],
        updateMode: "none",
      });
      try {
        await awaitGateBeforeSettlement(
          selection.selected,
          pending,
          "Transcript turn settled before selecting its target",
        );
        replaceSessionEntrySync(scope(), {
          sessionId,
          updatedAt: 2,
          lifecycleRevision: "successor",
        });
      } finally {
        selection.resume();
      }
      await expect(pending).resolves.toMatchObject({
        rejectedReason: "session-rebound",
        appendedCount: 0,
      });
      expect(loadSessionEntryReadOnly(scope())?.lifecycleRevision).toBe("successor");
      expect(loadTranscriptEventsSync(scope())).toEqual([]);
    },
  );

  it("does not downgrade a deleted persisted selection into a transcript-only append", async () => {
    replaceSessionEntrySync(scope(), { sessionId, updatedAt: 1 });
    const selection = pauseTargetSelection();
    const pending = persistSessionTranscriptTurn(scope("agent:main:global"), {
      messages: [{ message }],
      updateMode: "none",
    });
    try {
      await awaitGateBeforeSettlement(
        selection.selected,
        pending,
        "Transcript turn settled before selecting its target",
      );
      retainWindowOnly();
    } finally {
      selection.resume();
    }
    await expect(pending).resolves.toMatchObject({
      rejectedReason: "session-rebound",
      appendedCount: 0,
    });
    expect(loadSessionEntryReadOnly(scope())).toBeUndefined();
    expect(loadTranscriptEventsSync(scope())).toEqual([]);
  });

  it.each(["appears", "disappears"])(
    "does not adopt a changed creation precondition when the original entry %s",
    async (change) => {
      const entry = { sessionId, updatedAt: 1 };
      if (change === "disappears") {
        replaceSessionEntrySync(scope(), entry);
      }
      const selection = pauseTargetSelection();
      const pending = persistSessionTranscriptTurn(scope(), {
        expectedSessionId: sessionId,
        initialSessionEntry: entry,
        messages: [{ message }],
        updateMode: "none",
      });
      try {
        await awaitGateBeforeSettlement(
          selection.selected,
          pending,
          "Transcript turn settled before selecting its target",
        );
        if (change === "appears") {
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
