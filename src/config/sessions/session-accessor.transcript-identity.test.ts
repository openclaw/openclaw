import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  readOpenClawAgentDatabaseRegistryToken,
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import * as transcriptTargets from "./session-accessor.transcript-target.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { readSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";
import {
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
} from "./session-store-target-inventory.js";
import {
  prepareSessionStoreTargetInventoryRead,
  withSessionStoreTarget,
} from "./session-store-target-runtime.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { useTempSessionsFixture } from "./test-helpers.js";

afterAll(clearRuntimeConfigSnapshot);

const fixture = useTempSessionsFixture("openclaw-transcript-identity-");
beforeEach(() => setRuntimeConfigSnapshot({}));
const sessionId = "selected-window";
const scope = (sessionKey = "global") => ({
  agentId: "main",
  sessionId,
  sessionKey,
  storePath: fixture.storePath(),
});
const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
const entry = (lifecycleRevision?: string, updatedAt = 1) => ({
  sessionId,
  updatedAt,
  lifecycleRevision,
});
const message = { role: "user", content: "Selected conversation" };
const persist = (
  sessionKey: string,
  options: Partial<Parameters<typeof persistSessionTranscriptTurn>[1]> = {},
) =>
  persistSessionTranscriptTurn(scope(sessionKey), {
    expectedSessionId: sessionId,
    messages: [{ message }],
    updateMode: "none",
    ...options,
  });
const keys = () =>
  database().db.prepare("SELECT session_key FROM session_nodes ORDER BY session_key").all();
const retainWindowOnly = (sessionKey?: string) =>
  database()
    .db.prepare(
      "UPDATE session_nodes SET entry_json = '{}', entry_valid = -1" +
        (sessionKey ? " WHERE session_key = ?" : ""),
    )
    .run(...(sessionKey ? [sessionKey] : []));
const warmEntry = (target: ReturnType<typeof scope>) =>
  readSessionEntriesFromStoreInWorker({
    agentId: "main",
    storePath: target.storePath,
    sessionKeys: [target.sessionKey],
  });
const resolveQualified = (target: ReturnType<typeof scope>) =>
  transcriptTargets.resolveSessionTranscriptRuntimeTarget(target, undefined, {
    keyFormat: "agent-qualified",
  });
const readInventory = (
  config: Parameters<typeof prepareSessionStoreTargetInventory>[0],
  agent: string,
  env?: NodeJS.ProcessEnv,
) =>
  prepareSessionStoreTargetInventoryRead(
    prepareSessionStoreTargetInventory(config, [agent], env),
  ).withRead(async (result) => result.agents[0]?.result);

afterEach(() => vi.restoreAllMocks());

it("resolves the current transcript and lifecycle revision across entry writes", async () => {
  const selected = scope("agent:main:current");
  replaceSessionEntrySync(selected, entry("first"));
  await warmEntry(selected);
  expect(await resolveQualified(selected)).toMatchObject({
    sessionId,
    sessionKey: selected.sessionKey,
    selectedLifecycleRevision: "first",
  });
  await replaceSessionEntry(selected, entry("second", 2));
  expect(await resolveQualified(selected)).toMatchObject({
    sessionId,
    sessionKey: selected.sessionKey,
    selectedLifecycleRevision: "second",
  });
});

it("resolves a shared session ID to its transcript owner after the requested row's facts are retained", async () => {
  const base = scope("agent:main:cron:job");
  const run = scope(`${base.sessionKey}:run:${sessionId}`);
  replaceSessionEntrySync(base, entry("base"));
  replaceSessionEntrySync(run, entry("run", 2));
  await warmEntry(base);
  expect(await resolveQualified(base)).toMatchObject({
    sessionId,
    sessionKey: run.sessionKey,
    selectedSessionId: sessionId,
    selectedLifecycleRevision: "run",
  });
});

it("reuses a selected target until an owning registry write reassigns it", async () => {
  const storePath = `${fixture.storePath()}.custom.json`;
  const databasePath = `${fixture.storePath()}.custom.sqlite`;
  openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  const reads = vi.spyOn(targetDiscoveryLane.pool, "run");
  const select = () =>
    withSessionStoreTarget(
      {
        agentId: "main",
        storePath,
        env: process.env,
        candidates: captureSessionStoreReadCandidates(storePath),
      },
      async (target, owner) => {
        owner.assertCurrent();
        return target;
      },
    );
  expect((await select()).database.path).toBe(databasePath);
  const initialReads = reads.mock.calls.length;
  expect(initialReads).toBeGreaterThan(0);
  expect((await select()).database.path).toBe(databasePath);
  expect(reads).toHaveBeenCalledTimes(initialReads);

  unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  registerOpenClawAgentDatabase({ agentId: "other", path: databasePath });
  const reassigned = await select();
  expect(reassigned.database.path).toBe(`${fixture.storePath()}.custom.main.sqlite`);
  expect(reads.mock.calls.length).toBeGreaterThan(initialReads);
});

it.each(["fixed", "family"])(
  "refreshes %s inventory after an in-process session write",
  async (kind) => {
    const storePath = `${fixture.storePath()}.${kind === "fixed" ? "shared.sqlite" : "family.json"}`;
    const siblingPath = kind === "fixed" ? storePath : `${fixture.storePath()}.family.other.sqlite`;
    const config = { agents: { entries: { main: {}, other: {} } }, session: { store: storePath } };
    const request = prepareSessionStoreTargetInventory(config, ["other"]);
    if (kind === "fixed") {
      replaceSessionEntrySync({ ...scope("agent:main:global"), storePath }, entry());
    } else {
      openOpenClawAgentDatabase({ agentId: "other", path: siblingPath });
    }
    const reads = vi.spyOn(targetDiscoveryLane.pool, "run");
    const select = () =>
      kind === "fixed"
        ? readInventory(config, "other")
        : prepareSessionStoreTargetInventoryRead(request).withRead(
            async (inventory) => inventory.agents[0]?.result,
          );
    expect(await select()).toEqual({ available: true, targets: [] });
    const initialReads = reads.mock.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    expect(await select()).toEqual({ available: true, targets: [] });
    expect(reads).toHaveBeenCalledTimes(initialReads);
    const registry = readOpenClawAgentDatabaseRegistryToken();
    replaceSessionEntrySync(
      { agentId: "other", storePath: siblingPath, sessionKey: "agent:other:global" },
      { sessionId: "other-window", updatedAt: 2 },
    );
    expect(await select()).toEqual({
      available: true,
      targets: [{ agentId: "other", storePath }],
    });
    expect(reads.mock.calls.length).toBeGreaterThan(initialReads);
    if (kind === "family") {
      expect(readOpenClawAgentDatabaseRegistryToken()).toBe(registry);
    }
  },
);

it("reuses per-agent inventory and cleanup after ordinary session writes", async () => {
  const storePath = fixture.storePath();
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.resolve(fixture.sessionsDir(), "../../.."),
  };
  const session = { agentId: "main", storePath, sessionKey: "agent:main:global", env };
  replaceSessionEntrySync(session, entry());
  const reads = vi.spyOn(targetDiscoveryLane.pool, "run");
  const closes = vi.spyOn(targetDiscoveryLane.pool, "closeResources");
  const select = () => readInventory({ agents: { entries: { main: {} } } }, "main", env);
  const expected = { available: true, targets: [{ agentId: "main", storePath }] };
  expect(await select()).toEqual(expected);
  const initialReads = reads.mock.calls.length;
  const initialCloses = closes.mock.calls.length;
  expect(initialReads).toBeGreaterThan(0);

  replaceSessionEntrySync(session, entry(undefined, 2));
  expect(await select()).toEqual(expected);
  expect(reads).toHaveBeenCalledTimes(initialReads);
  expect(closes).toHaveBeenCalledTimes(initialCloses);
});

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

it.each(["same owner", "state retirement"] as const)(
  "keeps post-selection first registration bound to its %s",
  async (change) => {
    const target = { ...scope(), storePath: `${fixture.storePath()}.custom.json` };
    const databaseOptions = toDatabaseOptions(resolveSqliteScope(target));
    const shared = openOpenClawStateDatabase();
    const run = targetDiscoveryLane.pool.run.bind(targetDiscoveryLane.pool);
    const selected = createDeferred();
    const resume = createDeferred();
    let reads = 0;
    vi.spyOn(targetDiscoveryLane.pool, "run").mockImplementation(async (...args) => {
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
          agentId: "main",
        });
        if (change === "state retirement") {
          selected.resolve();
          await resume.promise;
        }
      }
      return reply;
    });
    const pending = transcriptTargets.resolveSessionTranscriptRuntimeTarget(target);
    if (change === "same owner") {
      await expect(pending).resolves.toMatchObject(target);
    } else {
      try {
        await awaitGateBeforeSettlement(
          selected.promise,
          pending,
          "Transcript target read settled before its first registration",
        );
        // Lifecycle retirement runs outside the cold reader's writer reservation.
        await closeOpenClawStateDatabaseByPathAsync(shared.path);
        openOpenClawStateDatabase();
      } finally {
        resume.resolve();
      }
      await expect(pending).rejects.toMatchObject({
        code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
      });
    }
    expect(reads).toBe(1);
  },
);

it.each([
  { stored: "unknown", requested: "agent:main:unknown", mainKey: undefined },
  { stored: "agent:main:main", requested: "agent:main:main", mainKey: "custom" },
])(
  "preserves the physical row $stored when writing $requested",
  async ({ stored, requested, mainKey }) => {
    setRuntimeConfigSnapshot(mainKey ? { session: { mainKey } } : {});
    replaceSessionEntrySync(scope(stored), entry());
    if (mainKey) {
      setCanonicalSqliteSessionMainKey(database(), mainKey);
    }
    await expect(
      persist(requested, mainKey ? { config: { session: { mainKey } } } : {}),
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
    replaceSessionEntrySync(scope(), entry());
    replaceSessionEntrySync(scope("agent:main:global"), {
      sessionId: "competing-window",
      updatedAt: 1,
    });
    if (kind === "retained window") {
      retainWindowOnly("agent:main:global");
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
    const initial = entry(revision);
    if (change !== "appears") {
      replaceSessionEntrySync(scope(), initial);
    }
    const creation = change === "appears" || change === "disappears";
    const selection = pauseTargetSelection();
    const pending = persist(creation ? "global" : "agent:main:global", {
      expectedSessionId: change === "delete" ? undefined : sessionId,
      ...(creation ? { initialSessionEntry: initial } : {}),
      expectedLifecycleRevision: expected,
    });
    try {
      await awaitGateBeforeSettlement(
        selection.selected,
        pending,
        "Transcript turn settled before selecting its target",
      );
      if (change === "revision") {
        replaceSessionEntrySync(scope(), entry("successor", 2));
      } else if (change === "appears") {
        replaceSessionEntrySync(scope(), initial);
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
  const initial = entry("unchanged");
  replaceSessionEntrySync(scope(), initial);
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
          { sessionKey: "agent:main:global", previousSessionKeys: ["global"], entry: initial },
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
