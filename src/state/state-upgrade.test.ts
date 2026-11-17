import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { load as loadSqliteVec } from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { createDoctorChain } from "./state-upgrade-doctor.js";
import { copyTree, pruneGenerations, writePlan } from "./state-upgrade-tree.js";
import { ChainStepError } from "./state-upgrade-validate.js";
import { isStateUpgradePending, upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
        runChain: async ({ stateDir: shadow }) => {
          if (upgradeShared) {
            expect(fs.existsSync(path.join(shadow, "agents", "retired"))).toBe(false);
            using state = new DatabaseSync(path.join(shadow, "state", "openclaw.sqlite"));
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
      expect(fs.readdirSync(retainedDir)).toEqual(["openclaw-agent.sqlite"]);
      expect(fs.readFileSync(activePath)).toEqual(activeBytes);
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
  it("points agent-directory selectors into the private copy and names its live directory", async () => {
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
      stateDir: path.join(root, "shadow"),
      configPath: path.join(root, "shadow", "openclaw.json"),
      logPath,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, "live"),
        OPENCLAW_AGENT_DIR: path.join(root, "live", "agents", "main", "agent"),
        PI_CODING_AGENT_DIR: path.join(root, "elsewhere"),
      },
    });
    expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual([
      path.join(root, "shadow", "agents", "main", "agent"),
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
  it("publishes a config outside the state directory by a rename within its directory", async () => {
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
    const renames = vi.spyOn(fs, "renameSync");
    try {
      await upgradeStateDirectory({
        env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        log: { info: () => {}, warn: () => {} },
        runChain: async (chain) => {
          fs.writeFileSync(chain.configPath, JSON.stringify({ migrated: true }));
          throw new ChainStepError("injected", "fail after the config rewrite");
        },
      });
      const publish = renames.mock.calls.find(([, to]) => to === configPath);
      expect(path.dirname(String(publish?.[0]))).toBe(path.dirname(configPath));
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ migrated: true });
    } finally {
      renames.mockRestore();
    }
  });
});

describe("upgradeStateDirectory code roots", () => {
  it("leaves Git release installations out of the private copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-code-"));
    dirs.push(root);
    const stateDir = path.join(root, "state");
    const corpus = fileURLToPath(
      new URL("../../test/fixtures/state-corpus-populated/2026.10.10/state/", import.meta.url),
    );
    fs.cpSync(corpus, stateDir, { recursive: true });
    const release = path.join(stateDir, "git-install", "releases", "r1", "package.json");
    fs.mkdirSync(path.dirname(release), { recursive: true });
    fs.writeFileSync(release, "{}");
    const copied: boolean[] = [];
    await upgradeStateDirectory({
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json") },
      log: { info: () => {}, warn: () => {} },
      runChain: async (chain) => {
        copied.push(fs.existsSync(path.join(chain.stateDir, "git-install")));
        throw new ChainStepError("injected", "stop after the copy");
      },
    });
    expect(copied).toEqual([false]);
    expect(fs.readFileSync(release, "utf8")).toBe("{}");
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

describe("startup copy ownership", () => {
  it("skips bulk and large unrelated SQLite, retains legacy inputs and retired backups", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-scope-"));
    dirs.push(root);
    const stateDir = path.join(root, "state");
    fs.cpSync(
      fileURLToPath(
        new URL("../../test/fixtures/state-corpus-populated/2026.10.10/state/", import.meta.url),
      ),
      stateDir,
      { recursive: true },
    );
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
      "media/outgoing/originals",
      "browser",
      "backups",
      "cache",
    ];
    for (const dir of bulk) {
      fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
      fs.writeFileSync(path.join(stateDir, dir, "keep.sqlite.bak"), "operator data");
    }
    const records = path.join(stateDir, "media/outgoing/records");
    fs.mkdirSync(records, { recursive: true });
    fs.writeFileSync(path.join(records, "legacy.json"), "{}");
    const archived = path.join(stateDir, "archive.sqlite");
    const db = new DatabaseSync(archived);
    db.exec("CREATE TABLE payload (value TEXT)");
    db.close();
    fs.truncateSync(archived, 64 * 1024 * 1024 + 1);
    const retired = path.join(stateDir, "state/openclaw.sqlite.pre-startup-migration-test.bak");
    fs.writeFileSync(retired, "operator recovery");
    const oldGeneration = path.join(stateDir, "state/openclaw.sqlite.pre-2026.1.1");
    fs.writeFileSync(oldGeneration, "prior upgrade");
    const calls = vi.spyOn(fs, "readdirSync");
    const log = { info: vi.fn(), warn: vi.fn() };
    let observed:
      | { bulk: boolean[]; archive: boolean; records: string; agent: boolean }
      | undefined;
    const result = await upgradeStateDirectory({
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      log,
      runChain: async ({ stateDir: shadow }) => {
        observed = {
          bulk: bulk.map((dir) => fs.existsSync(path.join(shadow, dir))),
          archive: fs.existsSync(path.join(shadow, "archive.sqlite")),
          records: fs.readFileSync(path.join(shadow, "media/outgoing/records/legacy.json"), "utf8"),
          agent: fs.existsSync(path.join(shadow, "agents/main/agent/openclaw-agent.sqlite")),
        };
        throw new ChainStepError("injected", "exercise fallback retention");
      },
    });
    expect(result.status).toBe("upgraded");
    expect(observed).toEqual({
      bulk: bulk.map(() => false),
      archive: false,
      records: "{}",
      agent: true,
    });
    expect(fs.readFileSync(retired, "utf8")).toBe("operator recovery");
    expect(fs.existsSync(oldGeneration)).toBe(false);
    for (const dir of bulk) {
      expect(
        calls.mock.calls.some(([file]) => file === path.join(stateDir, dir)),
        dir,
      ).toBe(false);
      expect(fs.readFileSync(path.join(stateDir, dir, "keep.sqlite.bak"), "utf8")).toBe(
        "operator data",
      );
    }
    const state = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"));
    try {
      const report = state
        .prepare("SELECT payload_json FROM diagnostic_events WHERE scope = 'upgrade.report'")
        .get();
      expect(JSON.parse(String(report?.payload_json)).retiredBackups).toEqual({
        count: 1,
        bytes: 17,
      });
    } finally {
      state.close();
    }
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("retained 1 retired backup file(s), 17 bytes"),
    );
  });

  it("refuses insufficient space before copying with exact required and available bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-space-"));
    dirs.push(root);
    const live = path.join(root, "live");
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, "config.json"), "{}");
    const statfs = fs.statfsSync(live, { bigint: true });
    vi.spyOn(fs, "statfsSync").mockReturnValue({ ...statfs, bavail: 1n, bsize: 1n });
    const shadow = path.join(root, "shadow");
    await expect(copyTree(live, shadow, () => false, new Map())).rejects.toThrow(
      "needs 2 bytes plus 268435456 bytes margin (268435458 bytes total); only 1 bytes available. Free 268435457 bytes",
    );
    expect(fs.existsSync(shadow)).toBe(false);
    expect(fs.readdirSync(live)).toEqual(["config.json"]);
    expect(fs.readFileSync(path.join(live, "config.json"), "utf8")).toBe("{}");
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
