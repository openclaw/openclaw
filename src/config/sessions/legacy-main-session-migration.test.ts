import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "../../infra/kysely-sync.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  assignHumanOwner,
  databasePath,
  humanOwner,
  outcomeKinds,
  readClaim,
  recordHarnessDeletions,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import * as retirement from "./session-retirement-read.js";
import type { SessionRetirementReadOperation } from "./session-retirement-read.types.js";
import { runSessionStartupMigration } from "./startup-migration.js";
import * as sessionTargets from "./targets.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

function migrate(
  { cfg, env }: Pick<ReturnType<typeof createFixture>, "cfg" | "env">,
  mode: "detect" | "doctor-fix" = "detect",
  forceScan?: boolean,
) {
  return migrateLegacyMainSessionKeys({ cfg, env, mode, forceScan });
}

function claim(databaseAgentId: string, pathname: string, key = `agent:${databaseAgentId}:chat`) {
  return { databaseAgentId, databasePath: pathname, key };
}

const explicitAgents = { ownership: "explicit", entries: { ops: {}, research: {} } } as const;
function storeFixture(store: string) {
  return createFixture({ agents: { entries: { ops: {} } }, session: { store } });
}

describe("legacy main session migration", () => {
  it("scales legacy store path inspection linearly with the fleet", async () => {
    const inspectionCounts: number[] = [];
    for (const size of [16, 32]) {
      const agentIds = Array.from({ length: size }, (_, index) => `agent-${index}`);
      const entries = Object.fromEntries(agentIds.map((agentId) => [agentId, {}]));
      const fixture = createFixture({ agents: { ownership: "explicit", entries } });
      const paths = new Set(agentIds.map((agentId) => databasePath(fixture.stateDir, agentId)));
      for (const pathname of paths) {
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
      }
      const realpath = vi.spyOn(fs.realpathSync, "native");
      try {
        const result = await migrate(fixture);
        expect(result).toMatchObject({ complete: true, outcomes: [{ kind: "no-legacy-rows" }] });
        const inspected = realpath.mock.calls
          .map(([pathname]) => String(pathname))
          .filter((pathname) => paths.has(pathname));
        expect(new Set(inspected).size).toBe(size);
        inspectionCounts.push(inspected.length);
      } finally {
        realpath.mockRestore();
      }
    }
    expect(inspectionCounts[1]).toBeLessThanOrEqual(inspectionCounts[0]! * 2);
  });

  it("migrates an in-place alias atomically to the owner key", async () => {
    const storePath = path.join(tempDirs.make("in-place-migration-"), "sessions.sqlite");
    const fixture = storeFixture(storePath);
    seedClaim(claim("main", storePath));
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        writeSessionProgressCard(db, "agent:main:chat", {
          markdown: "Keep working on the existing task",
        });
        db.prepare(
          "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (?, ?, 'progress', 'Still working', 10, 10)",
        ).run("agent:main:chat", "agent:main:chat");
      },
      { agentId: "main", path: storePath },
    );

    const { result, committed } = await recordHarnessDeletions(() =>
      migrate(fixture, "doctor-fix"),
    );

    expect(outcomeKinds(result)).toContain("migrated-in-place");
    expect(committed).toEqual(["agent:main:chat"]);
    expect(readClaim(claim("main", storePath))).toBeUndefined();
    expect(readClaim(claim("main", storePath, "agent:ops:chat"))).toBeDefined();
    const migratedArtifacts = runOpenClawAgentWriteTransaction(
      ({ db }) => ({
        heartbeat: db.prepare("SELECT session_key, run_session_key FROM heartbeat_outcomes").get(),
        progressCard: readSessionProgressCard(db, "agent:ops:chat"),
      }),
      { agentId: "main", path: storePath },
    );
    expect(migratedArtifacts).toMatchObject({
      heartbeat: { session_key: "agent:ops:chat", run_session_key: "agent:ops:chat" },
      progressCard: {
        markdown: "Keep working on the existing task",
        revision: 1,
        sessionKey: "agent:ops:chat",
      },
    });
  });

  it.each(["not-armed", "migrated-in-place", "divergent-aliases"] as const)(
    "reports the %s outcome",
    async (kind) => {
      const root = tempDirs.make("outcome-stores-");
      const main = claim("main", path.join(root, "sessions.main.sqlite"));
      const ops = claim("main", path.join(root, "sessions.ops.sqlite"));
      const fixture =
        kind === "not-armed"
          ? createFixture({ agents: { entries: { main: {}, ops: {} } } })
          : storeFixture(
              kind === "migrated-in-place"
                ? main.databasePath
                : path.join(root, "sessions.{agentId}.sqlite"),
            );
      if (kind === "migrated-in-place") {
        seedClaim(main);
      } else if (kind === "divergent-aliases") {
        seedClaim({ ...main, entry: { sessionId: "alias-one", updatedAt: 100 } });
        seedClaim({ ...ops, entry: { sessionId: "alias-two", updatedAt: 200 } });
      }
      const result = await migrate(fixture);
      expect(outcomeKinds(result)).toContain(kind);
      if (kind === "divergent-aliases") {
        expect(readClaim(main)).toBeDefined();
        expect(readClaim(ops)).toBeDefined();
      } else {
        expect(result.changes).toEqual([]);
      }
    },
  );

  it("preserves a canonical owner created while alias deletion is preparing", async () => {
    const storePath = path.join(tempDirs.make("in-place-owner-race-"), "sessions.sqlite");
    const fixture = storeFixture(storePath);
    const source = claim("main", storePath);
    const canonical = { ...source, key: "agent:ops:chat" };
    seedClaim(source);
    const sourceBefore = readClaim(source);
    let canonicalBefore: ReturnType<typeof readClaim>;

    const { result, committed } = await recordHarnessDeletions(
      () => migrate(fixture, "doctor-fix"),
      () => {
        seedClaim({
          ...canonical,
          entry: { sessionId: "concurrent-owner", updatedAt: 200 },
          events: [{ type: "message", id: "concurrent-event" }],
        });
        canonicalBefore = readClaim(canonical);
      },
    );

    expect(readClaim(canonical)).toEqual(canonicalBefore);
    expect(readClaim(source)).toEqual(sourceBefore);
    expect(committed).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it.each([false, true])(
    "quarantines losing claims without overwriting existing quarantine keys (assigned owner: %s)",
    async (hasHumanOwner) => {
      const fixture = createFixture();
      const mainPath = databasePath(fixture.stateDir, "main");
      seedClaim({ ...claim("main", mainPath), entry: { sessionId: "legacy", updatedAt: 100 } });
      if (hasHumanOwner) {
        assignHumanOwner(mainPath);
      }
      seedClaim({
        ...claim("main", mainPath, "agent:ops:legacy-main-conflict-1"),
        entry: { sessionId: "occupied", updatedAt: 50 },
      });
      seedClaim({
        ...claim("ops", databasePath(fixture.stateDir, "ops")),
        entry: { sessionId: "canonical", updatedAt: 200 },
      });

      const { result, committed } = await recordHarnessDeletions(() =>
        migrate(fixture, "doctor-fix"),
      );

      expect(committed).toEqual(["agent:main:chat"]);
      const outcome = result.outcomes.find((entry) => entry.kind === "divergent-canonical");
      expect(outcome?.quarantinedKeys).toEqual(["agent:ops:legacy-main-conflict-2"]);
      expect(readClaim(claim("main", mainPath))).toBeUndefined();
      const quarantined = readClaim(claim("main", mainPath, "agent:ops:legacy-main-conflict-2"));
      expect(quarantined?.events).toEqual(['{"type":"message","id":"event-1","text":"hello"}']);
      expect(quarantined?.entry.owner).toEqual(hasHumanOwner ? humanOwner : undefined);
    },
  );

  it("uses an explicit migration owner when the multi-agent roster is unambiguous", async () => {
    const resolved = createFixture({
      agents: { ...explicitAgents, defaults: { sessionStore: { agentId: "ops" } } },
      session: { store: path.join(tempDirs.make("fixed-store-owner-"), "sessions.sqlite") },
    });
    const unresolved = createFixture({ agents: explicitAgents });
    seedClaim(claim("main", databasePath(unresolved.stateDir, "main")));
    const perAgentPinned = createFixture({
      agents: { ...explicitAgents, defaults: { sessionStore: { agentId: "ops" } } },
    });

    const armed = await migrate(resolved);
    const notArmed = await migrate(unresolved);
    const perAgentArmed = await migrate(perAgentPinned);

    expect(armed).toMatchObject({ armed: true, ownerAgentId: "ops" });
    expect(notArmed).toMatchObject({
      armed: false,
      outcomes: [{ kind: "not-armed", detail: "owner-unresolved" }],
    });
    expect(perAgentArmed).toMatchObject({ armed: true, ownerAgentId: "ops" });
    expect(notArmed.warnings[0]).toContain("agents.defaults.sessionStore.agentId");
  });

  it("proves an unresolved-owner store clean when it has no legacy rows", async () => {
    const fixture = createFixture({ agents: explicitAgents });

    const result = await migrate(fixture);

    expect(result).toMatchObject({
      armed: false,
      complete: true,
      ledgerComplete: false,
      outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
      warnings: [],
    });
  });

  it("keeps unresolved ownership advisory when a candidate store is unreadable", async () => {
    const unreadablePath = path.join(tempDirs.make("unresolved-unreadable-"), "sessions.sqlite");
    fs.symlinkSync(`${unreadablePath}.missing`, unreadablePath);
    const fixture = createFixture({ agents: explicitAgents, session: { store: unreadablePath } });

    const result = await migrate(fixture);

    expect(result).toMatchObject({
      armed: false,
      complete: false,
      ledgerComplete: false,
      outcomes: [{ kind: "not-armed", detail: "owner-unresolved" }],
    });
    expect(result.warnings[0]).toContain("agents.defaults.sessionStore.agentId");
  });

  it("keeps detection non-throwing for unreadable stores and treats ENOENT as absence", async () => {
    const absent = createFixture();
    const unreadablePath = path.join(tempDirs.make("detect-unreadable-"), "sessions.sqlite");
    fs.symlinkSync(`${unreadablePath}.missing`, unreadablePath);
    const unreadable = storeFixture(unreadablePath);

    const absentResult = await migrate(absent);
    const unreadableResult = await migrate(unreadable);

    expect(absentResult).toMatchObject({ complete: true, outcomes: [{ kind: "no-legacy-rows" }] });
    expect(outcomeKinds(unreadableResult)).toContain("store-unreadable");
    expect(unreadableResult.warnings.join("\n")).toContain(unreadablePath);
    await expect(migrate(unreadable, "doctor-fix")).rejects.toThrow(
      `cannot read legacy session store ${unreadablePath}`,
    );
  });
});

it.each(["doctor-fix", "detect"] as const)(
  "%s reads only legacy-targeted transcripts across stores without materializing them",
  async (mode) => {
    return withOpenClawTestState({ label: "legacy-main-targeted" }, async (state) => {
      seedSessions(state.stateDir, "ops", ["agent:ops:one", "agent:ops:two", "agent:ops:three"]);
      seedSessions(state.stateDir, "main", ["agent:main:two"]);
      const reads = recordTranscriptReads();
      const retirementReads = recordRetirementReads();

      const result = await migrate(
        { cfg: { agents: { entries: { ops: {} } } }, env: state.env },
        mode,
      );

      expect(result.outcomes).toEqual([
        expect.objectContaining({ kind: "divergent-canonical", canonicalKey: "agent:ops:two" }),
      ]);
      const transcriptReads = reads();
      if (mode === "detect") {
        expect(transcriptReads).toEqual([]);
        expect(
          retirementReads
            .flatMap((read) => (read.operation === "comparison-claims" ? read.keys : []))
            .toSorted((left, right) => left.key.localeCompare(right.key)),
        ).toEqual([
          { key: "agent:main:two", canonicalKey: "agent:ops:two" },
          { key: "agent:ops:two", canonicalKey: "agent:ops:two" },
        ]);
        return;
      }
      // Doctor and worker comparison share the same streaming generation reader.
      expect(transcriptReads.length).toBeGreaterThan(0);
      expect(new Set(transcriptReads.flatMap((read) => read.parameters))).toEqual(
        new Set(["agent:main:two", "agent:ops:two"]),
      );
      expect(transcriptReads.filter((read) => read.eager)).toEqual([]);
    });
  },
);

function recordRetirementReads(): SessionRetirementReadOperation[] {
  const requests: SessionRetirementReadOperation[] = [];
  const capture = retirement.captureSessionRetirementReader;
  vi.spyOn(retirement, "captureSessionRetirementReader").mockImplementation((...args) => {
    const reader = capture(...args);
    const read = reader.read;
    vi.spyOn(reader, "read").mockImplementation((request) => {
      requests.push(request);
      return read(request);
    });
    return reader;
  });
  return requests;
}

function seedSessions(stateDir: string, agentId: string, keys: string[]): void {
  for (const key of keys) {
    seedClaim({
      ...claim(agentId, databasePath(stateDir, agentId), key),
      entry: { sessionId: key, updatedAt: 100 },
      events: Array.from({ length: 3 }, (_, index) => ({
        type: "message",
        id: `${key}-${index}`,
        text: "synthetic transcript",
      })),
    });
  }
}

function recordTranscriptReads() {
  const eager = vi.spyOn(sqlite, "executeSqliteQuerySync");
  const streamed = vi.spyOn(sqlite, "iterateSqliteQuerySync");
  return () =>
    [eager, streamed].flatMap((spy) =>
      spy.mock.calls.flatMap(([, query]) => {
        const compiled = query.compile();
        return /^select\b[\s\S]*\bfrom "transcript_events"/.test(compiled.sql)
          ? [{ eager: spy === eager, parameters: compiled.parameters }]
          : [];
      }),
    );
}

it("rejects startup when session-store discovery fails", async () => {
  const stateDir = tempDirs.make("openclaw-startup-discovery-");
  vi.spyOn(sessionTargets, "resolveAllAgentSessionStoreTargetsSync").mockImplementation(() => {
    throw new Error("session-store discovery failed");
  });
  await expect(
    runSessionStartupMigration({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      log: { info: vi.fn(), warn: vi.fn() },
    }),
  ).rejects.toThrow("session-store discovery failed");
});

it("reports legacy session repairs without rewriting stored claims at startup", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-startup-doctor-only-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  await withEnvAsync({ OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir }, async () => {
    const env = { ...process.env };
    const cfg = { agents: { entries: { ops: { workspace } } } };
    setRuntimeConfigSnapshot(cfg);
    const legacy = { agentId: "main", env, sessionKey: "agent:main:retained" };
    const canonical = { agentId: "ops", env, sessionKey: "agent:ops:retained" };
    const worktree = { agentId: "ops", env, sessionKey: "agent:ops:workspace" };
    await replaceSessionEntry(legacy, { sessionId: "retained-history", updatedAt: Date.now() });
    await replaceSessionEntry(worktree, {
      sessionId: "workspace-history",
      updatedAt: Date.now(),
      worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot: workspace },
    });
    const beforeLegacy = loadSessionEntry(legacy);
    const beforeWorktree = loadSessionEntry(worktree);
    const log = { info: vi.fn(), warn: vi.fn() };
    const handoffDatabase = vi.fn(async () => {});
    await runSessionStartupMigration({ cfg, env, log, handoffDatabase });
    expect.soft(loadSessionEntry(legacy)).toEqual(beforeLegacy);
    expect.soft(loadSessionEntry(canonical)).toBeUndefined();
    expect.soft(loadSessionEntry(worktree)).toEqual(beforeWorktree);
    expect(handoffDatabase).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  });
});

it("keys the startup shortcut to source layout and makes Doctor rescan", async () => {
  const fixture = createFixture();
  const { cfg, env, stateDir } = fixture;
  const target = (agentId: string, key: string, pathname = databasePath(stateDir, agentId)) => ({
    databaseAgentId: agentId,
    databasePath: pathname,
    key,
  });
  const mainPath = databasePath(stateDir, "main");
  seedClaim({ ...target("main", "agent:other:keep"), events: [] });
  await migrate(fixture, "doctor-fix");

  const changedStore = await migrate({
    cfg: {
      ...cfg,
      session: { store: path.join(tempDirs.make("changed-layout-"), "sessions.sqlite") },
    },
    env,
  });
  expect(changedStore.outcomes).toEqual([{ kind: "no-legacy-rows" }]);
  expect(changedStore.ledgerComplete).toBe(false);

  const restoredPath = path.join(path.dirname(stateDir), "restored-main.sqlite");
  seedClaim({ ...target("main", "agent:main:restored", restoredPath), events: [] });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  fs.renameSync(mainPath, `${mainPath}.before-restore`);
  fs.renameSync(restoredPath, mainPath);
  const restored = await migrate(fixture, "doctor-fix");
  expect(restored.outcomes.map((outcome) => outcome.kind)).toContain("migrated-cross-store");
  expect(readClaim(target("main", "agent:main:restored"))).toBeUndefined();
  expect(readClaim(target("ops", "agent:ops:restored"))).toBeDefined();

  const jsonPath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, "{}\n");
  const laterJson = await migrate(fixture);
  expect(laterJson.outcomes.map((outcome) => outcome.kind)).toContain("legacy-json-store");
  fs.unlinkSync(jsonPath);

  seedClaim({ ...target("main", "agent:main:late"), events: [] });
  const startupShortcut = await migrate(fixture);
  expect(startupShortcut.outcomes).toEqual([
    { kind: "no-legacy-rows", detail: "matching completed ledger" },
  ]);
  expect(startupShortcut.ledgerComplete).toBe(true);
  expect(readClaim(target("main", "agent:main:late"))).toBeDefined();

  const scan = await migrate(fixture, "detect", true);
  expect(scan.ledgerComplete).toBe(false);
  expect(outcomeKinds(scan)).toContain("migrated-cross-store");
  expect(readClaim(target("main", "agent:main:late"))).toBeDefined();

  const repaired = await migrate(fixture, "doctor-fix");
  expect(repaired.ledgerComplete).toBe(true);
  expect(repaired.outcomes.map((outcome) => outcome.kind)).toContain("migrated-cross-store");
  expect(readClaim(target("main", "agent:main:late"))).toBeUndefined();
  expect(readClaim(target("ops", "agent:ops:late"))).toBeDefined();
});
