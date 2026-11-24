import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { sqliteDatabaseAdmissionState } from "../infra/sqlite-database-admission-context.js";
import { captureSqliteDatabaseDescriptorCustodyLocations } from "../infra/sqlite-database-admission.js";
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
import { readUpgradeConfig } from "./state-upgrade-config.js";
import { createDoctorChain } from "./state-upgrade-doctor.js";
import { applyPlan, copyTree, pruneGenerations, writePlan } from "./state-upgrade-tree.js";
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

it("releases admitted source and successor descriptors before replacing a database", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-custody-")));
  dirs.push(root);
  const live = path.join(root, "live.sqlite");
  const next = path.join(root, "next.sqlite");
  [live, next].forEach((file, index) => {
    {
      using db = new DatabaseSync(file);
      db.exec("CREATE TABLE witness (value INTEGER)");
      db.prepare("INSERT INTO witness VALUES (?)").run(index);
    }
    // Vitest is a worker, not admission's host. Retain the host's real descriptor custody.
    const descriptor = fs.openSync(file, "r");
    sqliteDatabaseAdmissionState.registry.retainDescriptorCustody(
      file,
      descriptor,
      fs.fstatSync(descriptor, { bigint: true }),
    );
  });
  expect([...captureSqliteDatabaseDescriptorCustodyLocations()]).toEqual(
    expect.arrayContaining([live, next]),
  );

  applyPlan({ appVersion: "custody-test", ops: [{ kind: "replace", live, next }] });

  const retained = [...captureSqliteDatabaseDescriptorCustodyLocations()];
  expect(retained).not.toContain(live);
  expect(retained).not.toContain(next);
  using published = new DatabaseSync(live, { readOnly: true });
  expect(published.prepare("SELECT value FROM witness").get()).toEqual({ value: 1 });
  using previous = new DatabaseSync(`${live}.pre-custody-test`, { readOnly: true });
  expect(previous.prepare("SELECT value FROM witness").get()).toEqual({ value: 0 });
});

describe("legacy registry upgrade discovery", () => {
  it.each(["2026.7.1", "2026.7.1-blob", "2026.7.35"])(
    "discovers %s without requiring the runtime registry schema or changing it",
    (release) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-discovery-"));
      dirs.push(stateDir);
      fs.cpSync(
        fileURLToPath(
          new URL(`../../test/fixtures/state-corpus-populated/${release}/state/`, import.meta.url),
        ),
        stateDir,
        { recursive: true },
      );
      const statePath = path.join(stateDir, "state", "openclaw.sqlite");
      const before = fs.readFileSync(statePath);
      expect(
        isStateUpgradePending({
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        }),
      ).toBe(true);
      expect(fs.readFileSync(statePath)).toEqual(before);
    },
  );
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
  it.each(["chain", "fallback", "refused", "mounted-chain", "mounted-fallback"])(
    "keeps nested absolute include migration private through %s publication",
    async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-includes-"));
      dirs.push(root);
      const stateDir = path.join(root, "state");
      const statePath = path.join(stateDir, "state", "openclaw.sqlite");
      const mountedWorkspace = mode === "mounted-chain" || mode === "mounted-fallback";
      const fallback = mode === "fallback" || mode === "mounted-fallback";
      const configDir = mountedWorkspace ? stateDir : path.join(root, "config");
      const configPath = path.join(configDir, "openclaw.json");
      const includeRelative = mountedWorkspace ? "workspace/agents.json" : "nested/agents.json";
      const includePath = path.join(configDir, includeRelative);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.mkdirSync(path.dirname(includePath), { recursive: true });
      const authored = JSON.stringify({
        gateway: { mode: "local" },
        agents: { $include: includePath },
      });
      const workspace = path.join(stateDir, "workspace");
      const original = JSON.stringify({ defaults: { workspace, maxConcurrent: 2 } });
      const migrated = JSON.stringify({ defaults: { workspace, maxConcurrent: 3 } });
      fs.writeFileSync(configPath, authored);
      fs.writeFileSync(includePath, original);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "unrelated.txt"), "not an input");
      {
        using db = new DatabaseSync(statePath);
        db.exec(OPENCLAW_STATE_SCHEMA_SQL);
        db.exec("PRAGMA user_version = " + (OPENCLAW_STATE_SCHEMA_VERSION - 1));
      }
      const before = fs.readFileSync(statePath);
      if (mountedWorkspace) {
        const workspaceStat = fs.statSync(workspace);
        let directorySynced = false;
        const sync = fs.fsyncSync;
        vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          const stat = fs.fstatSync(fd);
          if (stat.dev === workspaceStat.dev && stat.ino === workspaceStat.ino) {
            directorySynced = true;
          }
          sync(fd);
        });
        const rename = fs.renameSync;
        vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
          if (process.platform !== "win32" && path.basename(String(destination)) === "plan.json") {
            expect(directorySynced).toBe(true);
          }
          if (
            String(destination).startsWith(`${workspace}${path.sep}`) &&
            !String(source).startsWith(`${workspace}${path.sep}`)
          ) {
            throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
          }
          rename(source, destination);
        });
      }
      const result = await upgradeStateDirectory({
        env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        log: { info() {}, warn() {} },
        runChain: async (shadow) => {
          const config = readUpgradeConfig(shadow.configPath).config;
          expect(config.agents?.defaults?.maxConcurrent).toBe(2);
          expect(fs.existsSync(path.join(shadow.stateDir, "workspace", "unrelated.txt"))).toBe(
            false,
          );
          const shadowInclude = path.join(path.dirname(shadow.configPath), includeRelative);
          fs.writeFileSync(shadowInclude, migrated);
          if (mountedWorkspace) {
            fs.writeFileSync(`${shadowInclude}.bak`, original);
          }
          if (fallback) {
            throw new ChainStepError("injected", "after include migration");
          }
          using db = new DatabaseSync(path.join(shadow.stateDir, "state", "openclaw.sqlite"));
          db.exec("PRAGMA user_version = " + OPENCLAW_STATE_SCHEMA_VERSION);
          return { warnings: [] };
        },
        admitConfig: async (shadow) => {
          expect(readUpgradeConfig(shadow.configPath).config.agents?.defaults?.maxConcurrent).toBe(
            3,
          );
          expect(fs.readFileSync(includePath, "utf8")).toBe(original);
          return mode === "refused" ? "injected invalid migrated config" : undefined;
        },
      });
      expect(fs.readFileSync(configPath, "utf8")).toBe(authored);
      if (mode === "refused") {
        expect(result.status).toBe("refused");
        expect(fs.readFileSync(includePath, "utf8")).toBe(original);
        expect(fs.readFileSync(statePath)).toEqual(before);
      } else {
        expect(result).toMatchObject({
          status: "upgraded",
          mode: fallback ? "fallback" : "chain",
        });
        expect(fs.readFileSync(includePath, "utf8")).toBe(migrated);
        if (mode === "mounted-chain") {
          expect(fs.readFileSync(`${includePath}.bak`, "utf8")).toBe(original);
        }
        expect(
          fs.readdirSync(path.dirname(includePath)).some((name) => name.startsWith(".agents.json")),
        ).toBe(false);
        const backup = fs
          .readdirSync(path.dirname(includePath))
          .find((name) => name.startsWith("agents.json.pre-"));
        expect(backup).toBeDefined();
        expect(fs.readFileSync(path.join(path.dirname(includePath), backup!), "utf8")).toBe(
          original,
        );
      }
    },
  );
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
