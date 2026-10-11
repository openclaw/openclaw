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
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import * as retirement from "./session-retirement-read.js";
import type { SessionRetirementReadOperation } from "./session-retirement-read.types.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();
afterEach(() => vi.restoreAllMocks());

type LegacyMainSessionMigrationOutcomeKind = Awaited<
  ReturnType<typeof migrateLegacyMainSessionKeys>
>["outcomes"][number]["kind"];

describe("legacy main session migration", () => {
  it("migrates an in-place alias atomically to the owner key", async () => {
    const storePath = path.join(tempDirs.make("in-place-migration-"), "sessions.sqlite");
    const fixture = createFixture({
      agents: { entries: { ops: {} } },
      session: { store: storePath },
    });
    seedClaim({ databaseAgentId: "main", databasePath: storePath, key: "agent:main:chat" });
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionProgressCard(database.db, "agent:main:chat", {
          markdown: "Keep working on the existing task",
        });
        database.db
          .prepare(
            "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (?, ?, 'progress', 'Still working', 10, 10)",
          )
          .run("agent:main:chat", "agent:main:chat");
      },
      { agentId: "main", path: storePath },
    );

    const { result, committed } = await recordHarnessDeletions(() =>
      migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env: fixture.env,
        mode: "doctor-fix",
      }),
    );

    expect(outcomeKinds(result)).toContain("migrated-in-place");
    expect(committed).toEqual(["agent:main:chat"]);
    expect(
      readClaim({ databaseAgentId: "main", databasePath: storePath, key: "agent:main:chat" }),
    ).toBeUndefined();
    expect(
      readClaim({ databaseAgentId: "main", databasePath: storePath, key: "agent:ops:chat" }),
    ).toBeDefined();
    const migratedArtifacts = runOpenClawAgentWriteTransaction(
      (database) => ({
        heartbeat: database.db
          .prepare("SELECT session_key, run_session_key FROM heartbeat_outcomes")
          .get(),
        progressCard: readSessionProgressCard(database.db, "agent:ops:chat"),
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

  const closedOutcomeCases = [
    {
      kind: "not-armed",
      run: async () => {
        const fixture = createFixture({ agents: { entries: { main: {}, ops: {} } } });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(result.changes).toEqual([]);
        return result;
      },
    },
    {
      kind: "migrated-in-place",
      run: async () => {
        const fixture = createFixture({
          agents: { entries: { ops: {} } },
          session: { store: path.join(tempDirs.make("shared-store-"), "sessions.sqlite") },
        });
        seedClaim({
          databaseAgentId: "main",
          databasePath: fixture.cfg.session!.store!,
          key: "agent:main:chat",
        });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(result.changes).toEqual([]);
        return result;
      },
    },
    {
      kind: "divergent-aliases",
      run: async () => {
        const root = tempDirs.make("alias-stores-");
        const fixture = createFixture({
          agents: { entries: { ops: {} } },
          session: { store: path.join(root, "sessions.{agentId}.sqlite") },
        });
        seedClaim({
          databaseAgentId: "main",
          databasePath: path.join(root, "sessions.main.sqlite"),
          entry: { sessionId: "alias-one", updatedAt: 100 },
          key: "agent:main:chat",
        });
        seedClaim({
          databaseAgentId: "main",
          databasePath: path.join(root, "sessions.ops.sqlite"),
          entry: { sessionId: "alias-two", updatedAt: 200 },
          key: "agent:main:chat",
        });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(
          readClaim({
            databaseAgentId: "main",
            databasePath: path.join(root, "sessions.main.sqlite"),
            key: "agent:main:chat",
          }),
        ).toBeDefined();
        expect(
          readClaim({
            databaseAgentId: "main",
            databasePath: path.join(root, "sessions.ops.sqlite"),
            key: "agent:main:chat",
          }),
        ).toBeDefined();
        return result;
      },
    },
  ] satisfies Array<{
    kind: LegacyMainSessionMigrationOutcomeKind;
    run: () => Promise<Awaited<ReturnType<typeof migrateLegacyMainSessionKeys>>>;
  }>;

  it.each(closedOutcomeCases)("reports the $kind outcome", async ({ kind, run }) => {
    expect(outcomeKinds(await run())).toContain(kind);
  });

  it("preserves a canonical owner created while alias deletion is preparing", async () => {
    const storePath = path.join(tempDirs.make("in-place-owner-race-"), "sessions.sqlite");
    const fixture = createFixture({
      agents: { entries: { ops: {} } },
      session: { store: storePath },
    });
    const sourceTarget = {
      databaseAgentId: "main",
      databasePath: storePath,
      key: "agent:main:chat",
    };
    const canonicalTarget = { ...sourceTarget, key: "agent:ops:chat" };
    seedClaim(sourceTarget);
    const sourceBefore = readClaim(sourceTarget);
    let canonicalBefore: ReturnType<typeof readClaim>;

    const { result, committed } = await recordHarnessDeletions(
      () =>
        migrateLegacyMainSessionKeys({ cfg: fixture.cfg, env: fixture.env, mode: "doctor-fix" }),
      () => {
        seedClaim({
          ...canonicalTarget,
          entry: { sessionId: "concurrent-owner", updatedAt: 200 },
          events: [{ type: "message", id: "concurrent-event" }],
        });
        canonicalBefore = readClaim(canonicalTarget);
      },
    );

    expect(readClaim(canonicalTarget)).toEqual(canonicalBefore);
    expect(readClaim(sourceTarget)).toEqual(sourceBefore);
    expect(committed).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it.each([false, true])(
    "quarantines losing claims without overwriting existing quarantine keys (assigned owner: %s)",
    async (hasHumanOwner) => {
      const fixture = createFixture();
      const mainPath = databasePath(fixture.stateDir, "main");
      seedClaim({
        databaseAgentId: "main",
        databasePath: mainPath,
        entry: { sessionId: "legacy", updatedAt: 100 },
        key: "agent:main:chat",
      });
      if (hasHumanOwner) {
        assignHumanOwner(mainPath);
      }
      seedClaim({
        databaseAgentId: "main",
        databasePath: mainPath,
        entry: { sessionId: "occupied", updatedAt: 50 },
        key: "agent:ops:legacy-main-conflict-1",
      });
      seedClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        entry: { sessionId: "canonical", updatedAt: 200 },
        key: "agent:ops:chat",
      });

      const { result, committed } = await recordHarnessDeletions(() =>
        migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "doctor-fix",
        }),
      );

      expect(committed).toEqual(["agent:main:chat"]);
      const outcome = result.outcomes.find((entry) => entry.kind === "divergent-canonical");
      expect(outcome?.quarantinedKeys).toEqual(["agent:ops:legacy-main-conflict-2"]);
      expect(
        readClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" }),
      ).toBeUndefined();
      const quarantined = readClaim({
        databaseAgentId: "main",
        databasePath: mainPath,
        key: "agent:ops:legacy-main-conflict-2",
      });
      expect(quarantined?.events).toEqual(['{"type":"message","id":"event-1","text":"hello"}']);
      expect(quarantined?.entry.owner).toEqual(hasHumanOwner ? humanOwner : undefined);
    },
  );

  it("uses an explicit migration owner when the multi-agent roster is unambiguous", async () => {
    const resolved = createFixture({
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { store: path.join(tempDirs.make("fixed-store-owner-"), "sessions.sqlite") },
    });
    const unresolved = createFixture({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });
    seedClaim({
      databaseAgentId: "main",
      databasePath: databasePath(unresolved.stateDir, "main"),
      key: "agent:main:chat",
    });
    const perAgentPinned = createFixture({
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });

    const armed = await migrateLegacyMainSessionKeys({
      cfg: resolved.cfg,
      env: resolved.env,
      mode: "detect",
    });
    const notArmed = await migrateLegacyMainSessionKeys({
      cfg: unresolved.cfg,
      env: unresolved.env,
      mode: "detect",
    });
    const perAgentArmed = await migrateLegacyMainSessionKeys({
      cfg: perAgentPinned.cfg,
      env: perAgentPinned.env,
      mode: "detect",
    });

    expect(armed).toMatchObject({ armed: true, ownerAgentId: "ops" });
    expect(notArmed).toMatchObject({
      armed: false,
      outcomes: [{ kind: "not-armed", detail: "owner-unresolved" }],
    });
    expect(perAgentArmed).toMatchObject({ armed: true, ownerAgentId: "ops" });
    expect(notArmed.warnings[0]).toContain("agents.defaults.sessionStore.agentId");
  });

  it("proves an unresolved-owner store clean when it has no legacy rows", async () => {
    const fixture = createFixture({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });

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
    const fixture = createFixture({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: unreadablePath },
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });

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
    const unreadable = createFixture({
      agents: { entries: { ops: {} } },
      session: { store: unreadablePath },
    });

    const absentResult = await migrateLegacyMainSessionKeys({
      cfg: absent.cfg,
      env: absent.env,
      mode: "detect",
    });
    const unreadableResult = await migrateLegacyMainSessionKeys({
      cfg: unreadable.cfg,
      env: unreadable.env,
      mode: "detect",
    });

    expect(absentResult).toMatchObject({ complete: true, outcomes: [{ kind: "no-legacy-rows" }] });
    expect(outcomeKinds(unreadableResult)).toContain("store-unreadable");
    expect(unreadableResult.warnings.join("\n")).toContain(unreadablePath);
    await expect(
      migrateLegacyMainSessionKeys({
        cfg: unreadable.cfg,
        env: unreadable.env,
        mode: "doctor-fix",
      }),
    ).rejects.toThrow(`cannot read legacy session store ${unreadablePath}`);
  });
});

it.each(["doctor-fix", "detect"] as const)(
  "%s reads only legacy-targeted transcripts across stores without materializing them",
  async (mode) => {
    await withOpenClawTestState({ label: "legacy-main-targeted" }, async (state) => {
      seedSessions(state.stateDir, "ops", ["agent:ops:one", "agent:ops:two", "agent:ops:three"]);
      seedSessions(state.stateDir, "main", ["agent:main:two"]);
      const reads = recordTranscriptReads();
      const retirementReads = recordRetirementReads();

      const result = await migrateLegacyMainSessionKeys({
        cfg: { agents: { entries: { ops: {} } } },
        env: state.env,
        mode,
      });

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
  const pathname = databasePath(stateDir, agentId);
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (const key of keys) {
        writeSessionEntry(
          database,
          key,
          { sessionId: key, updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        );
        for (let index = 0; index < 3; index += 1) {
          appendTranscriptEventInTransaction(
            database,
            { agentId, path: pathname, sessionId: key, sessionKey: key },
            { type: "message", id: `${key}-${index}`, text: "synthetic transcript" },
            { allowStoredAlias: true },
          );
        }
      }
    },
    { agentId, path: pathname },
  );
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
  await expect(
    runSessionStartupMigration({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
      log: { info: vi.fn(), warn: vi.fn() },
      deps: {
        resolveAllAgentSessionStoreTargetsSync() {
          throw new Error("session-store discovery failed");
        },
      },
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
  const { cfg, env, stateDir } = createFixture();
  const root = path.dirname(stateDir);
  const claim = (agentId: string, key: string, pathname = databasePath(stateDir, agentId)) => ({
    databaseAgentId: agentId,
    databasePath: pathname,
    key,
  });
  const mainPath = databasePath(stateDir, "main");
  seedClaim({ ...claim("main", "agent:other:keep"), events: [] });
  await migrateLegacyMainSessionKeys({ cfg, env, mode: "doctor-fix" });

  const changedStore = await migrateLegacyMainSessionKeys({
    cfg: {
      ...cfg,
      session: { store: path.join(tempDirs.make("changed-layout-"), "sessions.sqlite") },
    },
    env,
    mode: "detect",
  });
  expect(changedStore.outcomes).toEqual([{ kind: "no-legacy-rows" }]);
  expect(changedStore.ledgerComplete).toBe(false);

  const restoredPath = path.join(root, "restored-main.sqlite");
  seedClaim({ ...claim("main", "agent:main:restored", restoredPath), events: [] });
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  fs.renameSync(mainPath, `${mainPath}.before-restore`);
  fs.renameSync(restoredPath, mainPath);
  const restored = await migrateLegacyMainSessionKeys({ cfg, env, mode: "doctor-fix" });
  expect(restored.outcomes.map((outcome) => outcome.kind)).toContain("migrated-cross-store");
  expect(readClaim(claim("main", "agent:main:restored"))).toBeUndefined();
  expect(readClaim(claim("ops", "agent:ops:restored"))).toBeDefined();

  const jsonPath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, "{}\n");
  const laterJson = await migrateLegacyMainSessionKeys({ cfg, env, mode: "detect" });
  expect(laterJson.outcomes.map((outcome) => outcome.kind)).toContain("legacy-json-store");
  fs.unlinkSync(jsonPath);

  seedClaim({ ...claim("main", "agent:main:late"), events: [] });
  const startupShortcut = await migrateLegacyMainSessionKeys({ cfg, env, mode: "detect" });
  expect(startupShortcut.outcomes).toEqual([
    { kind: "no-legacy-rows", detail: "matching completed ledger" },
  ]);
  expect(startupShortcut.ledgerComplete).toBe(true);
  expect(readClaim(claim("main", "agent:main:late"))).toBeDefined();

  const creationScan = await migrateLegacyMainSessionKeys({
    cfg,
    env,
    mode: "detect",
    forceScan: true,
  });
  expect(creationScan.ledgerComplete).toBe(false);
  expect(creationScan.outcomes.map((outcome) => outcome.kind)).toContain("migrated-cross-store");
  expect(readClaim(claim("main", "agent:main:late"))).toBeDefined();

  const repaired = await migrateLegacyMainSessionKeys({ cfg, env, mode: "doctor-fix" });
  expect(repaired.ledgerComplete).toBe(true);
  expect(repaired.outcomes.map((outcome) => outcome.kind)).toContain("migrated-cross-store");
  expect(readClaim(claim("main", "agent:main:late"))).toBeUndefined();
  expect(readClaim(claim("ops", "agent:ops:late"))).toBeDefined();
});
