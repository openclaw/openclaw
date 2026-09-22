import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
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
import type { SessionEntry } from "./types.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();

type LegacyMainSessionMigrationOutcomeKind = Awaited<
  ReturnType<typeof migrateLegacyMainSessionKeys>
>["outcomes"][number]["kind"];

function setLedgerStatus(env: NodeJS.ProcessEnv, status: string): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare("UPDATE migration_sources SET status = ? WHERE source_key = ?").run(
        status,
        "legacy-main-session-keys",
      );
    },
    { env },
    { operationLabel: "test.legacy-main-session-ledger-status" },
  );
}

function readLedgerReport(env: NodeJS.ProcessEnv): unknown {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const row = db
        .prepare("SELECT report_json FROM migration_sources WHERE source_key = ?")
        .get("legacy-main-session-keys") as { report_json?: unknown } | undefined;
      return typeof row?.report_json === "string" ? JSON.parse(row.report_json) : undefined;
    },
    { env },
  );
}

describe("legacy main session migration", () => {
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
      kind: "no-legacy-rows",
      run: async () => {
        const fixture = createFixture();
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
        expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
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
      kind: "migrated-cross-store",
      run: async () => {
        const fixture = createFixture();
        seedClaim({
          databaseAgentId: "main",
          databasePath: databasePath(fixture.stateDir, "main"),
          events: [{ kind: "repeat" }, { kind: "repeat" }],
          key: "agent:main:chat",
        });
        const result = await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "doctor-fix",
        });
        expect(
          readClaim({
            databaseAgentId: "ops",
            databasePath: databasePath(fixture.stateDir, "ops"),
            key: "agent:ops:chat",
          })?.events,
        ).toEqual(['{"kind":"repeat"}', '{"kind":"repeat"}']);
        return result;
      },
    },
    {
      kind: "canonical-exists-identical",
      run: async () => {
        const fixture = createFixture();
        const entry: SessionEntry = { sessionId: "same-session", updatedAt: 200 };
        seedClaim({
          databaseAgentId: "main",
          databasePath: databasePath(fixture.stateDir, "main"),
          entry,
          key: "agent:main:chat",
        });
        seedClaim({
          databaseAgentId: "ops",
          databasePath: databasePath(fixture.stateDir, "ops"),
          entry,
          key: "agent:ops:chat",
        });
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "doctor-fix",
        });
      },
    },
    {
      kind: "divergent-canonical",
      run: async () => {
        const fixture = createFixture();
        seedClaim({
          databaseAgentId: "main",
          databasePath: databasePath(fixture.stateDir, "main"),
          entry: { sessionId: "legacy", updatedAt: 100 },
          key: "agent:main:chat",
        });
        seedClaim({
          databaseAgentId: "ops",
          databasePath: databasePath(fixture.stateDir, "ops"),
          entry: { sessionId: "canonical", updatedAt: 100 },
          key: "agent:ops:chat",
        });
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
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
    {
      kind: "legacy-json-store",
      run: async () => {
        const fixture = createFixture();
        const jsonPath = path.join(fixture.stateDir, "agents", "main", "sessions", "sessions.json");
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
        fs.writeFileSync(jsonPath, "{}\n");
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
      },
    },
    {
      kind: "store-unreadable",
      run: async () => {
        const unreadablePath = path.join(tempDirs.make("unreadable-store-"), "sessions.sqlite");
        fs.symlinkSync(`${unreadablePath}.missing`, unreadablePath);
        const fixture = createFixture({
          agents: { entries: { ops: {} } },
          session: { store: unreadablePath },
        });
        return await migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "detect",
        });
      },
    },
  ] satisfies Array<{
    kind: LegacyMainSessionMigrationOutcomeKind;
    run: () => Promise<Awaited<ReturnType<typeof migrateLegacyMainSessionKeys>>>;
  }>;

  it.each(closedOutcomeCases)("reports the $kind outcome", async ({ kind, run }) => {
    expect(outcomeKinds(await run())).toContain(kind);
  });

  it("keeps divergent canonical claims intact and detects mid-stream transcript divergence", async () => {
    const fixture = createFixture();
    const entry: SessionEntry = { sessionId: "shared-id", updatedAt: 100 };
    seedClaim({
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      entry,
      events: [{ id: "one" }, { id: "legacy-two" }],
      key: "agent:main:chat",
    });
    seedClaim({
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      entry,
      events: [{ id: "one" }, { id: "canonical-two" }],
      key: "agent:ops:chat",
    });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });

    expect(outcomeKinds(result)).toContain("divergent-canonical");
    expect(result.complete).toBe(false);
    expect(
      readClaim({
        databaseAgentId: "main",
        databasePath: databasePath(fixture.stateDir, "main"),
        key: "agent:main:chat",
      }),
    ).toBeDefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeDefined();
  });

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

  it("uses a completed ledger once and rearms when its identity changes", async () => {
    const fixture = createFixture();
    const first = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
      now: () => 100,
    });
    const second = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
      now: () => 200,
    });
    expect(readLedgerReport(fixture.env)).toMatchObject({
      mainKey: "main",
      outcomes: [{ kind: "no-legacy-rows" }],
      ownerAgentId: "ops",
    });
    setLedgerStatus(fixture.env, "failed");
    const nonComplete = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });
    const changedMainKey: OpenClawConfig = {
      ...fixture.cfg,
      session: { ...fixture.cfg.session, mainKey: "primary" },
    };
    const rearmed = await migrateLegacyMainSessionKeys({
      cfg: changedMainKey,
      env: fixture.env,
      mode: "detect",
    });
    const reowned = await migrateLegacyMainSessionKeys({
      cfg: { agents: { entries: { research: {} } } },
      env: fixture.env,
      mode: "detect",
    });

    expect(first.complete).toBe(true);
    expect(second.outcomes).toEqual([
      { kind: "no-legacy-rows", detail: "matching completed ledger" },
    ]);
    expect(nonComplete.outcomes).toEqual([{ kind: "no-legacy-rows" }]);
    expect(rearmed.mainKey).toBe("primary");
    expect(rearmed.outcomes).toEqual([{ kind: "no-legacy-rows" }]);
    expect(reowned).toMatchObject({
      ownerAgentId: "research",
      outcomes: [{ kind: "no-legacy-rows" }],
    });
  });

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

  it("uses an explicit migration owner for retired main rows in per-agent stores", async () => {
    const fixture = createFixture({
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });
    const mainPath = databasePath(fixture.stateDir, "main");
    seedClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    expect(result).toMatchObject({ armed: true, complete: true, ownerAgentId: "ops" });
    expect(
      readClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" }),
    ).toBeUndefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeDefined();
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

  it("keeps detection read-only while a legacy JSON candidate blocks inspection", async () => {
    const fixture = createFixture();
    const mainPath = databasePath(fixture.stateDir, "main");
    seedClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" });
    const jsonPath = path.join(fixture.stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, "{}\n");

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });

    expect(outcomeKinds(result)).toContain("legacy-json-store");
    expect(result.changes).toEqual([]);
    expect(
      readClaim({ databaseAgentId: "main", databasePath: mainPath, key: "agent:main:chat" }),
    ).toBeDefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeUndefined();
  });

  it("dedupes symlinked state roots by physical database identity", async () => {
    const fixture = createFixture();
    fixture.cfg = {
      agents: { entries: { ops: {} } },
      session: {
        store: path.join(fixture.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    const stateAlias = path.join(path.dirname(fixture.stateDir), "state-alias");
    fs.symlinkSync(fixture.stateDir, stateAlias, "dir");
    seedClaim({
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      key: "agent:main:chat",
    });
    const env = { ...fixture.env, OPENCLAW_STATE_DIR: stateAlias };

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env,
      mode: "doctor-fix",
    });

    expect(
      result.outcomes.filter((outcome) => outcome.canonicalKey === "agent:ops:chat"),
    ).toHaveLength(1);
    expect(outcomeKinds(result)).toContain("migrated-cross-store");
  });
});
