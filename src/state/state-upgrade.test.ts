import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
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
import { copyTree, pruneGenerations, writePlan } from "./state-upgrade-tree.js";
import { ChainStepError } from "./state-upgrade-validate.js";
import { isStateUpgradePending, upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup reader replacement", () => {
  it("reopens shared-state workers after the copy-and-swap upgrade", async () => {
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
          runChain: async ({ stateDir: shadow }) => {
            using state = new DatabaseSync(path.join(shadow, "state", "openclaw.sqlite"));
            state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
            state.exec(
              `INSERT INTO config_machine_state VALUES ('plugins.bundledDiscovery', '"all"', 1)`,
            );
            return { warnings: [] };
          },
          admitConfig: async ({ stateDir: shadow }) => {
            await executeExistingOpenClawStateRead(
              { env: { ...env, OPENCLAW_STATE_DIR: shadow } },
              { type: "plugins.metadata.read", input: { stateKeys: ["plugins.bundledDiscovery"] } },
            );
            return undefined;
          },
          beforeSwap: async () => {
            await closeOpenClawStateDatabaseByPathAsync(statePath);
          },
        }),
      ).resolves.toMatchObject({ status: "upgraded", mode: "chain" });
    } finally {
      await lock?.release();
    }
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
  it("points agent-directory selectors into the private copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-chain-"));
    dirs.push(root);
    const entry = path.join(root, "entry.mjs");
    fs.writeFileSync(
      entry,
      "console.log(JSON.stringify([process.env.OPENCLAW_AGENT_DIR, process.env.PI_CODING_AGENT_DIR ?? null]));",
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
      "openclaw.sqlite.bak",
      "operator.sqlite.pre-1",
      "worktrees/openclaw.sqlite.pre-1",
    ]) {
      fs.writeFileSync(path.join(root, name), "kept");
    }
    const reads = vi.spyOn(fs, "readdirSync");
    expect(pruneGenerations(root, "3", new Set(["2"]), new Set([owned]))).toEqual([
      "openclaw.sqlite.pre-1",
    ]);
    expect(reads.mock.calls.map(([file]) => file)).toEqual([root]);
    for (const name of [
      "openclaw.sqlite.pre-2",
      "openclaw.sqlite.pre-3",
      "openclaw.sqlite.bak",
      "operator.sqlite.pre-1",
      "worktrees/openclaw.sqlite.pre-1",
    ]) {
      expect(fs.readFileSync(path.join(root, name), "utf8")).toBe("kept");
    }
  });
});

it.each([
  { completed: true, survivingOwner: false },
  { completed: false, survivingOwner: false },
  { completed: true, survivingOwner: true },
  { completed: true, survivingOwner: true, customStore: true },
  { completed: true, survivingOwner: false, symlinkState: true },
])("preserves deletion ownership during startup: %j", async (scenario) => {
  const { completed, survivingOwner, customStore, symlinkState } = scenario;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-retained-"));
  dirs.push(stateDir);
  if (symlinkState) {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-linked-state-"));
    dirs.push(sharedDir);
    fs.symlinkSync(sharedDir, path.join(stateDir, "state"), "junction");
  } else {
    fs.mkdirSync(path.join(stateDir, "state"));
  }
  const agentDir = path.join(stateDir, "agents", "retained", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const retainedPath = path.join(agentDir, "openclaw-agent.sqlite");
  fs.copyFileSync(
    fileURLToPath(
      new URL(
        "../../test/fixtures/state-corpus-populated/2026.10.10/state/agents/main/agent/openclaw-agent.sqlite",
        import.meta.url,
      ),
    ),
    retainedPath,
  );
  const before = fs.readFileSync(retainedPath);
  const state = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  state.exec(
    "PRAGMA user_version = " +
      (OPENCLAW_STATE_SCHEMA_VERSION - (symlinkState ? 1 : 0)) +
      "; CREATE TABLE config_machine_state(state_key TEXT, value_json TEXT); CREATE TABLE diagnostic_events(scope TEXT, event_key TEXT, payload_json TEXT, created_at INTEGER, sequence INTEGER, PRIMARY KEY(scope,event_key)); CREATE TABLE agent_deletion_journal(agent_id TEXT, cleanup_completed INTEGER, delete_files INTEGER, phase TEXT, agent_dir TEXT, database_paths_json TEXT);",
  );
  state
    .prepare("INSERT INTO agent_deletion_journal VALUES (?, ?, 0, ?, ?, ?)")
    .run("retained", Number(completed), "retiring", agentDir, JSON.stringify([retainedPath]));
  state.close();
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify(
      survivingOwner
        ? {
            agents: {
              list: [{ id: "survivor", agentDir }, ...(customStore ? [{ id: "other" }] : [])],
            },
            ...(customStore ? { session: { store: path.join(stateDir, "custom.json") } } : {}),
          }
        : {},
    ),
  );
  // Match startup custody: raw inventory is allowed, runtime database reentry is not.
  const lock = await acquireGatewayLock({ env, databaseAccess: "none", allowInTests: true });
  try {
    if (survivingOwner) {
      expect(isStateUpgradePending(env)).toBe(true);
      expect(fs.readFileSync(retainedPath)).toEqual(before);
      return;
    }
    expect(isStateUpgradePending(env)).toBe(false);
    expect(await upgradeStateDirectory({ env, log: { info() {}, warn() {} } })).toEqual({
      status: "current",
    });
    expect(fs.readFileSync(retainedPath)).toEqual(before);
    const liveDir = path.join(stateDir, "agents", "live", "agent");
    fs.mkdirSync(liveDir, { recursive: true });
    const livePath = path.join(liveDir, "openclaw-agent.sqlite");
    const live = new DatabaseSync(livePath);
    live.exec(
      "CREATE TABLE retained_value(value TEXT); INSERT INTO retained_value VALUES ('synthetic'); PRAGMA user_version = " +
        (OPENCLAW_AGENT_SCHEMA_VERSION - 1),
    );
    live.close();
    if (symlinkState) {
      const statePath = path.join(stateDir, "state", "openclaw.sqlite");
      const sharedBefore = fs.readFileSync(statePath);
      await expect(
        upgradeStateDirectory({
          env,
          log: { info() {}, warn() {} },
          runChain: async ({ stateDir: shadow }) => {
            expect(fs.existsSync(path.join(shadow, "agents", "retained"))).toBe(false);
            // Stop before publication: this case owns discovery and copy exclusion.
            throw Object.assign(new Error("stop after inspecting the private copy"), {
              code: "EIO",
            });
          },
        }),
      ).rejects.toThrow("stop after inspecting the private copy");
      expect(fs.readFileSync(retainedPath)).toEqual(before);
      expect(fs.readFileSync(statePath)).toEqual(sharedBefore);
      expect(fs.lstatSync(path.join(stateDir, "state")).isSymbolicLink()).toBe(true);
      return;
    }
    let copiedRetiredStore: boolean | undefined;
    const result = await upgradeStateDirectory({
      env,
      log: { info() {}, warn() {} },
      runChain: async ({ stateDir: shadow }) => {
        copiedRetiredStore = fs.existsSync(path.join(shadow, "agents", "retained"));
        throw new Error("exercise the real fallback for the live sibling");
      },
    });
    expect(result).toMatchObject({ status: "upgraded", mode: "fallback" });
    expect(copiedRetiredStore).toBe(false);
    expect(fs.readFileSync(retainedPath)).toEqual(before);
    const upgraded = new DatabaseSync(livePath, { readOnly: true });
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    } finally {
      upgraded.close();
    }
  } finally {
    await lock?.release();
  }
});
