import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import * as diskSpace from "../infra/disk-space.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as sqliteFileCopy from "../infra/sqlite-file-copy.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { createDoctorChain } from "./state-upgrade-doctor.js";
import { pruneGenerations, writePlan } from "./state-upgrade-tree.js";
import { ChainStepError } from "./state-upgrade-validate.js";
import { isStateUpgradePending, upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
/** The pre-migration image name this build gives a file. */
const preImage = (file: string) => `${file}.pre-${resolveRuntimeServiceBuildId() ?? VERSION}`;
const userVersion = (file: string) => {
  using db = new DatabaseSync(file, { readOnly: true });
  return db.prepare("PRAGMA user_version").get()?.user_version;
};
/** The updater's update_runs table, as the shipped schema creates it. */
const createUpdateRuns = (db: DatabaseSync) => {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS update_runs (");
  db.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(
      start,
      OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", start) + ") STRICT;".length,
    ),
  );
};
const insertUpdateRun = (db: DatabaseSync, runId: string) =>
  db
    .prepare(`INSERT INTO update_runs (run_id, created_at_ms, updated_at_ms, trigger, phase,
    status, origin_json, target_json, before_json, after_json, steps_json, verification_json,
    repair_json) VALUES (?, 1, 2, 'cli', 'restarting', 'running', '{}', '{}', '{}', '{}',
    '[{"step":"git-release-switch"}]', '{}', '[]')`)
    .run(runId);
const stateEnv = (stateDir: string) => ({
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json"),
});
const quiet = { info: () => {}, warn: () => {} };
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup reader replacement", () => {
  it("migrates in place, keeps the pre-image, and serves readers afterwards", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-readers-"));
    dirs.push(stateDir);
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
    const statePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    {
      using state = new DatabaseSync(statePath);
      state.exec("PRAGMA journal_mode = WAL");
      state.exec(OPENCLAW_STATE_SCHEMA_SQL);
      state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    }
    // The upgrade's file-only lock itself inspects the old database through a read worker.
    const lock = await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
    try {
      await expect(
        upgradeStateDirectory({
          env,
          log: { info() {}, warn() {} },
          custody: {
            run: (operation) => lock!.run(operation),
            handOff: (operation) => operation(),
          },
          runChain: async (chain) => {
            // The chain runs on the live state, not a copy.
            expect(chain.stateDir).toBe(stateDir);
            using state = new DatabaseSync(path.join(chain.stateDir, "state", "openclaw.sqlite"));
            state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
            state.exec(
              `INSERT INTO config_machine_state VALUES ('plugins.bundledDiscovery', '"all"', 1)`,
            );
            return { warnings: [] };
          },
          admitConfig: async (live) => {
            await executeExistingOpenClawStateRead(
              { env: { ...env, OPENCLAW_STATE_DIR: live.stateDir } },
              { type: "plugins.metadata.read", input: { stateKeys: ["plugins.bundledDiscovery"] } },
            );
            await closeOpenClawStateDatabaseByPathAsync(statePath);
            return undefined;
          },
        }),
      ).resolves.toMatchObject({ status: "upgraded", mode: "chain" });
    } finally {
      await lock?.release();
    }
    expect(userVersion(preImage(statePath))).toBe(OPENCLAW_STATE_SCHEMA_VERSION - 1);
    expect(userVersion(statePath)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(fs.readFileSync(preImage(env.OPENCLAW_CONFIG_PATH), "utf8")).toBe("{}");
    // Startup's first writer switches the renamed rollback-journal database back to WAL.
    using state = new DatabaseSync(statePath);
    state.exec(`PRAGMA journal_mode = WAL;
      UPDATE config_machine_state SET value_json = '"allowlist"'
      WHERE state_key = 'plugins.bundledDiscovery'`);
    await expect(
      executeExistingOpenClawStateRead(
        { env },
        { type: "plugins.metadata.read", input: { stateKeys: ["plugins.bundledDiscovery"] } },
      ),
    ).resolves.toMatchObject({
      type: "plugins.metadata.read",
      rows: [{ state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' }],
    });
    expect(isStateUpgradePending(env)).toBe(false);
  });
});

describe("startup retained deletion", () => {
  it.each([
    { cleanupCompleted: true, upgradeShared: false },
    { cleanupCompleted: true, upgradeShared: true },
    { cleanupCompleted: false, upgradeShared: false },
  ])(
    "preserves deletion ownership ($cleanupCompleted, shared upgrade=$upgradeShared)",
    async ({ cleanupCompleted, upgradeShared }) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-retained-"));
      dirs.push(stateDir);
      const env = {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      };
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
      const statePath = path.join(stateDir, "state", "openclaw.sqlite");
      const retainedDir = path.join(stateDir, "agents", "retired", "agent");
      const retainedPath = path.join(retainedDir, "openclaw-agent.sqlite");
      const activePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      for (const file of [statePath, retainedPath, activePath]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }
      {
        using state = new DatabaseSync(statePath);
        state.exec(OPENCLAW_STATE_SCHEMA_SQL);
        // Only the shared version stamp is behind in the copy-scope control.
        state.exec(
          `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - Number(upgradeShared)}`,
        );
        state
          .prepare(`INSERT INTO agent_deletion_journal
        (agent_id, operation_id, phase, agent_dir, workspace_dir, sessions_dir,
         database_paths_json, created_at, cleanup_completed, delete_files)
        VALUES ('retired', 'delete-retired', 'retiring', ?, ?, ?, ?, 1, ?, 0)`)
          .run(
            retainedDir,
            path.join(stateDir, "workspace-retired"),
            path.join(stateDir, "agents", "retired", "sessions"),
            JSON.stringify([retainedPath]),
            Number(cleanupCompleted),
          );
      }
      {
        using active = new DatabaseSync(activePath);
        active.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        active.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      }
      {
        using retained = new DatabaseSync(retainedPath, { allowExtension: true });
        retained.exec(
          fs.readFileSync(
            new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
            "utf8",
          ),
        );
        retained.exec(`PRAGMA user_version = 26;
        INSERT INTO schema_meta VALUES ('primary', 'agent', 26, 'retired', '2026.9.9', 1, 1);
        INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
          VALUES ('agent:retired:main', 'archived-session', '{"sessionId":"archived-session"}', 1);`);
        loadSqliteVec(retained);
        retained.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(embedding float[3]);
        INSERT INTO memory_index_chunks_vec(rowid, embedding) VALUES (1, '[1, 0, 0]');`);
      }
      const bytes = fs.readFileSync(retainedPath);
      const activeBytes = fs.readFileSync(activePath);
      const log = { info: vi.fn(), warn: vi.fn() };
      const upgrade = upgradeStateDirectory({
        env,
        log,
        runChain: async (chain) => {
          if (upgradeShared) {
            using state = new DatabaseSync(path.join(chain.stateDir, "state", "openclaw.sqlite"));
            state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
          }
          // Doctor leaves deleted agents to the deletion owner, including their old schemas.
          return { warnings: [] };
        },
      });
      if (cleanupCompleted) {
        await expect(upgrade).resolves.toMatchObject(
          upgradeShared ? { status: "upgraded", mode: "chain" } : { status: "current" },
        );
        expect(isStateUpgradePending(env)).toBe(false);
      } else {
        await expect(upgrade).rejects.toThrow("no such module: vec0");
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("failed at agent-schema"));
        expect(isStateUpgradePending(env)).toBe(true);
      }
      expect(fs.readFileSync(retainedPath)).toEqual(bytes);
      // A pending deletion is still an upgrade input: its pre-image stays for the next start.
      expect(fs.readdirSync(retainedDir).toSorted()).toEqual(
        cleanupCompleted
          ? ["openclaw-agent.sqlite"]
          : ["openclaw-agent.sqlite", path.basename(preImage(retainedPath))],
      );
      if (!cleanupCompleted) {
        expect(fs.readFileSync(preImage(retainedPath))).toEqual(bytes);
      }
      expect(fs.readFileSync(activePath)).toEqual(activeBytes);
      expect(fs.existsSync(preImage(activePath))).toBe(false);
    },
  );
});

describe("upgradeStateDirectory version zero", () => {
  it("leaves a PostgreSQL anchor or empty catalog to the normal bootstrap", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-v0-"));
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, "state"));
    const anchor = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
    anchor.exec("CREATE TABLE anchor (v TEXT)");
    anchor.close();
    // A SQLite agent family beside PostgreSQL shared state keeps the previous path.
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    const agent = new DatabaseSync(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    agent.exec("CREATE TABLE t (v TEXT); PRAGMA user_version = 41");
    agent.close();
    const env = stateEnv(stateDir);
    expect(isStateUpgradePending(env)).toBe(false);
    const result = await upgradeStateDirectory({
      env,
      log: quiet,
      runChain: async () => {
        throw new Error("the chain must not run");
      },
    });
    expect(result).toEqual({ status: "current" });
  });
});

describe("createDoctorChain", () => {
  it("runs Doctor on the live state and names it as its own directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-chain-"));
    dirs.push(root);
    const entry = path.join(root, "entry.mjs");
    fs.writeFileSync(
      entry,
      "console.log(JSON.stringify([process.env.OPENCLAW_AGENT_DIR, process.env.PI_CODING_AGENT_DIR ?? null, process.argv.slice(2)]));",
    );
    const logPath = path.join(root, "chain.log");
    await createDoctorChain(
      entry,
      [],
    )({
      stateDir: path.join(root, "live"),
      configPath: path.join(root, "live", "openclaw.json"),
      logPath,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, "live"),
        OPENCLAW_AGENT_DIR: path.join(root, "live", "agents", "main", "agent"),
        PI_CODING_AGENT_DIR: path.join(root, "elsewhere"),
      },
    });
    // Doctor reads "live directory = its own" as: the caller owns the pre-migration images.
    expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual([
      path.join(root, "live", "agents", "main", "agent"),
      null,
      [
        "doctor",
        "--fix",
        "--non-interactive",
        "--state-upgrade-live-state-dir",
        path.join(root, "live"),
      ],
    ]);
  });
});

describe("upgradeStateDirectory external config", () => {
  it("keeps a config outside the state directory as a pre-image beside it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-config-"));
    dirs.push(root);
    const stateDir = path.join(root, "state");
    const corpus = fileURLToPath(
      new URL("../../test/fixtures/state-corpus-populated/2026.10.10/state/", import.meta.url),
    );
    fs.cpSync(corpus, stateDir, { recursive: true });
    const configPath = path.join(root, "config", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, "{}");
    await upgradeStateDirectory({
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      log: quiet,
      runChain: async (chain) => {
        expect(chain.configPath).toBe(configPath);
        fs.writeFileSync(chain.configPath, JSON.stringify({ migrated: true }));
        throw new ChainStepError("injected", "fail after the config rewrite");
      },
    });
    // The failed chain's config migration stands; the original sits beside it for a revert.
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ migrated: true });
    expect(fs.readFileSync(preImage(configPath), "utf8")).toBe("{}");
  });
});

describe("upgradeStateDirectory resume", () => {
  it("releases retained handles before finishing an interrupted plan", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-resume-"));
    dirs.push(stateDir);
    const live = path.join(stateDir, "client", "credentials.sqlite");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, "old");
    const workDir = path.join(stateDir, ".upgrade-test-1-1");
    const next = path.join(workDir, "state", "client", "credentials.sqlite");
    fs.mkdirSync(path.dirname(next), { recursive: true });
    fs.writeFileSync(next, "new");
    writePlan(workDir, { appVersion: "test", ops: [{ kind: "replace", live, next }] });

    const seenAtRelease: string[] = [];
    const result = await upgradeStateDirectory({
      env: stateEnv(stateDir),
      log: quiet,
      beforeSwap: async () => {
        seenAtRelease.push(fs.readFileSync(live, "utf8"));
      },
    });

    expect(result).toEqual({ status: "resumed" });
    expect(seenAtRelease).toEqual(["old"]);
    expect(fs.readFileSync(live, "utf8")).toBe("new");
    expect(fs.readFileSync(`${live}.pre-test`, "utf8")).toBe("old");
  });
});

describe("startup pre-images", () => {
  /** The populated 2026.10.10 corpus: shared and agent databases older than this build. */
  function corpus(prefix: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(root);
    const stateDir = path.join(root, "state");
    fs.cpSync(
      fileURLToPath(
        new URL("../../test/fixtures/state-corpus-populated/2026.10.10/state/", import.meta.url),
      ),
      stateDir,
      { recursive: true },
    );
    return { root, stateDir };
  }
  /** A stand-in chain that commits each outdated schema bump in place. */
  const databases = (stateDir: string) => [
    [path.join(stateDir, "state/openclaw.sqlite"), OPENCLAW_STATE_SCHEMA_VERSION] as const,
    ...["main", "ops"].map(
      (agent) =>
        [
          path.join(stateDir, "agents", agent, "agent/openclaw-agent.sqlite"),
          OPENCLAW_AGENT_SCHEMA_VERSION,
        ] as const,
    ),
  ];
  const migrate = async ({ stateDir }: { stateDir: string }) => {
    for (const [file, version] of databases(stateDir)) {
      using db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${version}`);
    }
    return { warnings: [] };
  };

  it("images only the outdated databases and the config, and walks no bulk tree", async () => {
    const { stateDir } = corpus("openclaw-upgrade-scope-");
    const configPath = path.join(stateDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        worktreeRoot: path.join(stateDir, "custom-checkouts"),
        agents: { defaults: { workspace: path.join(stateDir, "custom-workspace") } },
      }),
    );
    const bulk = [
      "worktrees",
      "custom-checkouts",
      "custom-workspace",
      "knowledge",
      "media/inbound",
      "browser",
      "backups",
      "cache",
      "git-install/releases/r1",
    ];
    for (const dir of bulk) {
      fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
      fs.writeFileSync(path.join(stateDir, dir, "keep.sqlite.bak"), "operator data");
    }
    const archived = path.join(stateDir, "archive.sqlite");
    {
      using db = new DatabaseSync(archived);
      db.exec("CREATE TABLE payload (value TEXT)");
    }
    const retired = path.join(stateDir, "state/openclaw.sqlite.pre-startup-migration-test.bak");
    fs.writeFileSync(retired, "operator recovery");
    const oldGeneration = path.join(stateDir, "state/openclaw.sqlite.pre-2026.1.1");
    fs.writeFileSync(oldGeneration, "prior upgrade");
    const before = new Map(databases(stateDir).map(([file]) => [file, userVersion(file)] as const));
    const reads = vi.spyOn(fs, "readdirSync");

    const result = await upgradeStateDirectory({
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      log: quiet,
      runChain: migrate,
    });

    expect(result).toMatchObject({ status: "upgraded", mode: "chain", pinned: false });
    const generation = preImage("");
    const images = listDirectoryTreeStrictSync(stateDir)
      .map(({ relativePath }) => relativePath)
      .filter((name) => name.endsWith(generation));
    expect(images.toSorted()).toEqual(
      [
        "agents/main/agent/openclaw-agent.sqlite",
        "agents/ops/agent/openclaw-agent.sqlite",
        "openclaw.json",
        "state/openclaw.sqlite",
      ].map(preImage),
    );
    for (const [file, version] of before) {
      expect(userVersion(preImage(file))).toBe(version);
    }
    expect(fs.existsSync(preImage(archived))).toBe(false);
    expect(fs.readFileSync(retired, "utf8")).toBe("operator recovery");
    expect(fs.existsSync(oldGeneration)).toBe(false);
    for (const dir of bulk) {
      expect(
        reads.mock.calls.some(([file]) => file === path.join(stateDir, dir)),
        dir,
      ).toBe(false);
      expect(fs.readFileSync(path.join(stateDir, dir, "keep.sqlite.bak"), "utf8")).toBe(
        "operator data",
      );
    }
  });

  it("migrates without an image when a copy would not leave the migration its room", async () => {
    const { stateDir } = corpus("openclaw-upgrade-space-");
    const env = stateEnv(stateDir);
    // A filesystem that cannot clone, and a disk too full for a byte copy.
    const copy = sqliteFileCopy.copySqliteFile;
    vi.spyOn(sqliteFileCopy, "copySqliteFile").mockImplementation(
      async (source, target, identity, options) => {
        await options?.beforeByteCopy?.(Number(identity.size));
        return copy(source, target, identity, { clone: "never" });
      },
    );
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: 1024 * 1024,
      totalBytes: 1024 ** 3,
    }));
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await upgradeStateDirectory({ env, log, runChain: migrate });

    expect(result).toMatchObject({ status: "upgraded", mode: "chain" });
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    expect(userVersion(shared)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(fs.existsSync(preImage(shared))).toBe(false);
    expect(fs.readdirSync(path.dirname(shared)).some((name) => name.includes(".partial-"))).toBe(
      false,
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^No pre-migration image of state\/openclaw\.sqlite: this filesystem cannot clone, and a copy needs \d+ MiB with the migration's room while 1 MiB is free\. It is migrated in place; once its migration commits, the previous release cannot open it, so a failed start stays on this release and is fixed forward\.$/u,
      ),
    );
  });

  it("finishes a chain a kill interrupted after its databases were already current", async () => {
    const { stateDir } = corpus("openclaw-upgrade-interrupted-");
    // The killed start imaged each database, committed every migration, then died
    // before its Doctor finished the config: only its work directory says so.
    for (const [file] of databases(stateDir)) {
      fs.copyFileSync(file, preImage(file));
    }
    await migrate({ stateDir });
    const record = path.join(stateDir, `.upgrade-${preImage("").slice(".pre-".length)}-1-1`);
    fs.mkdirSync(record);
    const files = databases(stateDir).map(([file]) => file);
    fs.writeFileSync(
      path.join(record, "inventory.json"),
      JSON.stringify({
        files: [],
        outdated: files,
        started: files,
        images: files.map(preImage),
        stamps: {},
      }),
    );
    const env = stateEnv(stateDir);
    expect(isStateUpgradePending(env)).toBe(true);
    const chain = vi.fn(migrate);

    const result = await upgradeStateDirectory({
      env,
      log: quiet,
      runChain: chain,
    });

    expect(chain).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "upgraded", mode: "chain", pinned: false });
    for (const [file, version] of databases(stateDir)) {
      expect(userVersion(file)).toBe(version);
      // The interrupted start's images stay the baseline; nothing new was imaged.
      expect(userVersion(preImage(file))).toBeLessThan(version);
    }
    expect(isStateUpgradePending(env)).toBe(false);
  });

  it("keeps its record when the disk fills mid-chain, and the next start finishes it", async () => {
    const { stateDir } = corpus("openclaw-upgrade-midchain-");
    const env = stateEnv(stateDir);
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const sharedVersion = OPENCLAW_STATE_SCHEMA_VERSION;
    const original = userVersion(shared);
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });

    // The shared database's migration commits, then the disk fills before the agents'.
    await expect(
      upgradeStateDirectory({
        env,
        log: quiet,
        runChain: async () => {
          using db = new DatabaseSync(shared);
          db.exec(`PRAGMA user_version = ${sharedVersion}`);
          throw full;
        },
      }),
    ).rejects.toBe(full);
    const generation = preImage("").slice(".pre-".length);
    expect(
      fs.readdirSync(stateDir).filter((name) => name.startsWith(`.upgrade-${generation}-`)),
    ).toHaveLength(1);
    expect(isStateUpgradePending(env)).toBe(true);
    const info = vi.fn();

    const result = await upgradeStateDirectory({
      env,
      log: { info, warn: () => {} },
      runChain: migrate,
    });

    expect(result).toMatchObject({ status: "upgraded", mode: "chain", pinned: false });
    // The already-current shared database stays in the resumed set, on its first image.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`state/openclaw.sqlite v${sharedVersion}`),
    );
    expect(userVersion(preImage(shared))).toBe(original);
    for (const [file, version] of databases(stateDir)) {
      expect(userVersion(file)).toBe(version);
    }
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
  });

  it("replaces a leftover image of a finished upgrade instead of reusing it", async () => {
    const { stateDir } = corpus("openclaw-upgrade-stale-image-");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const original = userVersion(shared);
    fs.writeFileSync(preImage(shared), "not this run's baseline");

    await upgradeStateDirectory({
      env: stateEnv(stateDir),
      log: quiet,
      runChain: migrate,
    });

    expect(userVersion(preImage(shared))).toBe(original);
  });

  it("ends the Git release trial before Doctor runs, and a refused start stays migrated", async () => {
    const { stateDir } = corpus("openclaw-upgrade-trial-end-");
    const events: string[] = [];
    const warn = vi.fn();

    const result = await upgradeStateDirectory({
      env: stateEnv(stateDir),
      log: { info: () => {}, warn },
      endTrial: async (reason) => {
        events.push(`end: ${reason}`);
      },
      runChain: async (params) => {
        events.push("doctor");
        return await migrate(params);
      },
      admitConfig: async () => "the upgraded config is invalid (test)",
    });

    // Doctor can change files no image covers, so no revert is offered past this point.
    expect(events).toEqual(["end: the state is migrated in place", "doctor"]);
    expect(result).toMatchObject({ status: "refused" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("The databases stay migrated"));
    for (const [file, version] of databases(stateDir)) {
      expect(userVersion(file)).toBe(version);
      expect(fs.existsSync(preImage(file))).toBe(true);
    }
  });

  it.each(["chain", "fallback"] as const)(
    "keeps the update run the updater recorded before the restart (%s)",
    async (mode) => {
      const { stateDir } = corpus("openclaw-upgrade-update-run-");
      const shared = path.join(stateDir, "state/openclaw.sqlite");
      const runId = "11111111-2222-4333-8444-555555555555";
      const imported = "22222222-3333-4444-8555-666666666666";
      {
        // The updater's own release wrote this row just before restarting the Gateway.
        using db = new DatabaseSync(shared);
        createUpdateRuns(db);
        insertUpdateRun(db, runId);
      }

      const result = await upgradeStateDirectory({
        env: stateEnv(stateDir),
        log: quiet,
        runChain:
          mode === "chain"
            ? migrate
            : async () => {
                // Doctor imported a record into the live database, then a later step failed:
                // the rebuild reads the live database, so the import stays too.
                using db = new DatabaseSync(shared);
                insertUpdateRun(db, imported);
                throw new ChainStepError("injected", "force the generic rebuild");
              },
      });

      expect(result).toMatchObject({ status: "upgraded", mode });
      using db = new DatabaseSync(shared, { readOnly: true });
      expect(
        db.prepare("SELECT run_id, steps_json FROM update_runs ORDER BY run_id").all(),
      ).toEqual(
        [runId, ...(mode === "fallback" ? [imported] : [])].map((id) => ({
          run_id: id,
          steps_json: '[{"step":"git-release-switch"}]',
        })),
      );
    },
  );

  it("stops the fallback with the live WAL intact when SQLite cannot fold it in", async () => {
    const { stateDir } = corpus("openclaw-upgrade-fallback-wal-");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const runId = "33333333-4444-4555-8666-777777777777";
    let reader: DatabaseSync | undefined;
    try {
      await expect(
        upgradeStateDirectory({
          env: stateEnv(stateDir),
          log: quiet,
          runChain: async () => {
            // A reader's open snapshot blocks the checkpoint, so the new row lives only in
            // the WAL when the chain fails.
            reader = new DatabaseSync(shared);
            reader.exec("BEGIN");
            reader.prepare("SELECT count(*) FROM sqlite_master").get();
            {
              using db = new DatabaseSync(shared);
              createUpdateRuns(db);
              insertUpdateRun(db, runId);
            }
            throw new ChainStepError("injected", "force the generic rebuild");
          },
        }),
      ).rejects.toThrow(/could not fold the write-ahead log/u);
      expect(fs.statSync(`${shared}-wal`).size).toBeGreaterThan(0);
    } finally {
      reader?.exec("ROLLBACK");
      reader?.close();
    }
    using db = new DatabaseSync(shared, { readOnly: true });
    expect(db.prepare("SELECT run_id FROM update_runs").all()).toEqual([{ run_id: runId }]);
  });

  it.each([false, true])(
    "images a config privately, and never a linked one (linked: %s)",
    async (linked) => {
      const { root, stateDir } = corpus("openclaw-upgrade-config-image-");
      const configPath = path.join(stateDir, "openclaw.json");
      const shared = path.join(root, "dotfiles-openclaw.json");
      fs.rmSync(configPath, { force: true });
      fs.writeFileSync(linked ? shared : configPath, "{}", { mode: 0o644 });
      if (linked) {
        fs.symlinkSync(shared, configPath);
      }

      await upgradeStateDirectory({
        env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        log: quiet,
        runChain: migrate,
      });

      if (linked) {
        expect(fs.existsSync(preImage(configPath))).toBe(false);
        expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
      } else {
        expect(fs.lstatSync(preImage(configPath)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("finishes an interrupted run that another build of the same schemas started", async () => {
    const { stateDir } = corpus("openclaw-upgrade-other-build-");
    // A build that was replaced (fix forward) migrated every database, then stopped before
    // its Doctor finished the config and legacy files.
    const files = databases(stateDir).map(([file]) => file);
    const images = files.map((file) => `${file}.pre-2026.1.1-otherbuild`);
    files.forEach((file, index) => fs.copyFileSync(file, images[index]!));
    await migrate({ stateDir });
    const record = path.join(stateDir, ".upgrade-2026.1.1-otherbuild-1-1");
    fs.mkdirSync(record);
    fs.writeFileSync(
      path.join(record, "inventory.json"),
      JSON.stringify({ outdated: files, images }),
    );
    const chain = vi.fn(migrate);

    await upgradeStateDirectory({ env: stateEnv(stateDir), log: quiet, runChain: chain });

    expect(chain).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(record)).toBe(false);
    // The images it resumed on are the only pre-migration copies: they stay.
    expect(images.every((image) => fs.existsSync(image))).toBe(true);
  });

  it("never resumes or rebuilds a recorded database newer than this build", async () => {
    const { stateDir } = corpus("openclaw-upgrade-resume-newer-");
    const [, [agent, agentVersion]] = databases(stateDir) as [unknown, readonly [string, number]];
    {
      using db = new DatabaseSync(agent);
      db.exec(`PRAGMA user_version = ${agentVersion + 1}`);
    }
    const record = path.join(stateDir, `.upgrade-${preImage("").slice(".pre-".length)}-1-1`);
    fs.mkdirSync(record);
    fs.writeFileSync(
      path.join(record, "inventory.json"),
      JSON.stringify({ outdated: databases(stateDir).map(([file]) => file), images: [] }),
    );

    const result = await upgradeStateDirectory({
      env: stateEnv(stateDir),
      log: quiet,
      // A chain that migrates only what is older, as Doctor does.
      runChain: async ({ stateDir: dir }) => {
        for (const [file, version] of databases(dir)) {
          using db = new DatabaseSync(file);
          if (userVersion(file) < version) {
            db.exec(`PRAGMA user_version = ${version}`);
          }
        }
        return { warnings: [] };
      },
    });

    expect(result).toMatchObject({ status: "upgraded", mode: "chain" });
    expect(userVersion(agent)).toBe(agentVersion + 1);
  });

  it("keeps the upgrade pending when a signal stops Doctor", async () => {
    const { root, stateDir } = corpus("openclaw-upgrade-doctor-killed-");
    // Doctor's process is stopped by a signal before it finishes.
    const entry = path.join(root, "killed-doctor.mjs");
    fs.writeFileSync(entry, 'process.kill(process.pid, "SIGKILL");\n');

    await expect(
      upgradeStateDirectory({
        env: stateEnv(stateDir),
        log: quiet,
        runChain: createDoctorChain(entry, []),
      }),
    ).rejects.toThrow(/Doctor was stopped before it finished/u);

    // No generic rebuild ran over a half-done Doctor; the next start reruns it.
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(true);
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgraded-"))).toBe(false);
  });

  it("stops instead of resuming when an interrupted run's inventory cannot be read", async () => {
    const { stateDir } = corpus("openclaw-upgrade-inventory-unreadable-");
    // A directory in place of the inventory: present, but not readable as one.
    fs.mkdirSync(
      path.join(stateDir, `.upgrade-${preImage("").slice(".pre-".length)}-1-1`, "inventory.json"),
      {
        recursive: true,
      },
    );
    const chain = vi.fn(migrate);

    await expect(
      upgradeStateDirectory({ env: stateEnv(stateDir), log: quiet, runChain: chain }),
    ).rejects.toThrow(/EISDIR/u);
    expect(chain).not.toHaveBeenCalled();
  });

  it("resumes only with images the interrupted run published, never a leftover", async () => {
    const { stateDir } = corpus("openclaw-upgrade-resume-leftover-");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    // A finished earlier run of this build left an image; the interrupted run could not
    // image the database again and migrated it.
    fs.copyFileSync(shared, preImage(shared));
    {
      using db = new DatabaseSync(shared);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
    }
    const record = path.join(stateDir, `.upgrade-${preImage("").slice(".pre-".length)}-1-1`);
    fs.mkdirSync(record);
    fs.writeFileSync(
      path.join(record, "inventory.json"),
      JSON.stringify({ files: [], outdated: [shared], started: [shared], images: [], stamps: {} }),
    );
    const endTrial = vi.fn(async () => {});

    const result = await upgradeStateDirectory({
      env: stateEnv(stateDir),
      log: quiet,
      runChain: migrate,
      endTrial,
      admitConfig: async () => "the upgraded config is invalid (test)",
    });

    // Without its own image the set cannot be restored; the leftover is not used.
    expect(result).toMatchObject({ status: "refused" });
    expect(userVersion(shared)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(endTrial).toHaveBeenCalledWith("a database migrates without a pre-migration image");
  });

  it("skips the image when a copy layer wraps a full disk", async () => {
    const { stateDir } = corpus("openclaw-upgrade-wrapped-enospc-");
    vi.spyOn(sqliteFileCopy, "copySqliteFile").mockRejectedValue(
      new Error("SQLite file copy failed", {
        cause: Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        }),
      }),
    );
    const warn = vi.fn();

    const result = await upgradeStateDirectory({
      env: stateEnv(stateDir),
      log: { info: () => {}, warn },
      runChain: migrate,
    });

    expect(result).toMatchObject({ status: "upgraded", mode: "chain" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("No pre-migration image of state/openclaw.sqlite: the disk filled"),
    );
  });

  it("prunes only owned file generations and never descends into unrelated trees", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-prune-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "worktrees"));
    const owned = path.join(root, "openclaw.sqlite");
    for (const name of [
      "openclaw.sqlite",
      "openclaw.sqlite.pre-1",
      "openclaw.sqlite.pre-2",
      "openclaw.sqlite.pre-3",
      "openclaw.sqlite.pre-release-blue",
      "openclaw.sqlite.pre-startup-migration-1.bak",
      "openclaw.sqlite.bak",
      "operator.sqlite.pre-1",
      "worktrees/openclaw.sqlite.pre-1",
    ]) {
      fs.writeFileSync(path.join(root, name), "kept");
    }
    const reads = vi.spyOn(fs, "readdirSync");
    // A custom build ID names a generation as well as a version does.
    expect(pruneGenerations(root, "3", new Set(["2"]), new Set([owned])).toSorted()).toEqual([
      "openclaw.sqlite.pre-1",
      "openclaw.sqlite.pre-release-blue",
    ]);
    expect(reads.mock.calls.map(([file]) => file)).toEqual([root]);
    for (const name of [
      "openclaw.sqlite.pre-2",
      "openclaw.sqlite.pre-3",
      "openclaw.sqlite.pre-startup-migration-1.bak",
      "openclaw.sqlite.bak",
      "operator.sqlite.pre-1",
      "worktrees/openclaw.sqlite.pre-1",
    ]) {
      expect(fs.readFileSync(path.join(root, name), "utf8")).toBe("kept");
    }
  });
});
