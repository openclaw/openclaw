import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
    try {
      await expect(
        upgradeStateDirectory({
          env,
          log: { info() {}, warn() {} },
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
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json"),
    };
    expect(isStateUpgradePending(env)).toBe(false);
    const result = await upgradeStateDirectory({
      env,
      log: { info: () => {}, warn: () => {} },
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
      log: { info: () => {}, warn: () => {} },
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
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json") },
      log: { info: () => {}, warn: () => {} },
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
      log: { info: () => {}, warn: () => {} },
      runChain: migrate,
    });

    expect(result).toMatchObject({ status: "upgraded", mode: "chain", pinned: false });
    const generation = preImage("");
    const images = fs
      .readdirSync(stateDir, { recursive: true, encoding: "utf8" })
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
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json"),
    };
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
