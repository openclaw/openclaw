// Config guard tests cover program-level config checks before command execution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { formatCliCommand } from "../command-format.js";
import { ensureConfigReady, testApi } from "./config-guard.js";

const pluginPackagingRecoveryHint = [
  "This is a plugin packaging issue, not a local config problem.",
  "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
].join("\n");

const loadAndMaybeMigrateDoctorConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const setRuntimeConfigSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/doctor-config-preflight.js", () => ({
  runDoctorConfigPreflight: loadAndMaybeMigrateDoctorConfigMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  setRuntimeConfigSnapshot: setRuntimeConfigSnapshotMock,
}));

type ConfigIssue = { path: string; message: string };

function makeSnapshot() {
  return {
    exists: false,
    valid: true,
    issues: [] as ConfigIssue[],
    warnings: [] as ConfigIssue[],
    legacyIssues: [] as ConfigIssue[],
    path: "/tmp/openclaw.json",
  };
}

function makeRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function plainErrorCalls(runtime: ReturnType<typeof makeRuntime>): string[] {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  return runtime.error.mock.calls.map((call) => String(call[0]).replace(ansiPattern, ""));
}

async function withCapturedStdout(run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(String(chunk));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
    return writes.join("");
  } finally {
    writeSpy.mockRestore();
  }
}

describe("ensureConfigReady", () => {
  const resetConfigGuardStateForTests = testApi.resetConfigGuardStateForTests;
  const tempRoots: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  async function runEnsureConfigReady(commandPath: string[], suppressDoctorStdout = false) {
    const runtime = makeRuntime();
    await ensureConfigReady({ runtime: runtime as never, commandPath, suppressDoctorStdout });
    return runtime;
  }

  function setInvalidSnapshot(overrides?: Partial<ReturnType<typeof makeSnapshot>>) {
    const snapshot = {
      ...makeSnapshot(),
      exists: true,
      valid: false,
      issues: [{ path: "channels.quietchat", message: "invalid" }],
      ...overrides,
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
      snapshot,
      baseConfig: {},
    });
  }

  function useTempOpenClawHome(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-"));
    tempRoots.push(root);
    setTestEnvValue("OPENCLAW_HOME", root);
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    return root;
  }

  function writeLegacyTaskSidecarMarker(root: string): void {
    const markerPath = path.join(root, ".openclaw", "tasks", "runs.sqlite");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  }

  function writePendingTaskSidecarArchiveMarker(root: string): void {
    const markerPath = path.join(root, ".openclaw", "tasks", "runs.sqlite");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(`${markerPath}.migrated`, "");
    fs.writeFileSync(`${markerPath}-wal`, "");
  }

  function writeStateMarker(root: string, relativePath: string): void {
    const markerPath = path.join(root, ".openclaw", relativePath);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
  }

  function writePluginStateKvMarker(root: string, pluginId: string, namespace: string): void {
    const dbPath = path.join(root, ".openclaw", "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE plugin_state_entries (
          plugin_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          entry_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (plugin_id, namespace, entry_key)
        );
      `);
      db.prepare(
        `INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, 'entry-1', '{"version":1}', 1, NULL)`,
      ).run(pluginId, namespace);
    } finally {
      db.close();
    }
  }

  function writeWorkboardLegacyKvMarker(root: string): void {
    writePluginStateKvMarker(root, "workboard", "workboard.cards");
  }

  function writeMSTeamsLearningMarker(
    storeDir: string,
    fileName = "bXN0ZWFtczp1c2VyMQ.learnings.json",
  ): void {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, fileName), JSON.stringify(["Prefer concise answers"]));
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_PROFILE",
      "OPENCLAW_DEBUG_PROXY_DB_PATH",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_WORKSPACE_DIR",
    ]);
    vi.clearAllMocks();
    resetConfigGuardStateForTests();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    useTempOpenClawHome();
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => ({
      snapshot: makeSnapshot(),
      baseConfig: {},
    }));
  });

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "skips doctor flow for status task reads without legacy state",
      commandPath: ["status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for update status",
      commandPath: ["update", "status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for agent without legacy state",
      commandPath: ["agent"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for gateway run without legacy state",
      commandPath: ["gateway", "run"],
      expectedDoctorCalls: 0,
    },
    {
      name: "runs doctor flow for commands that may mutate state without legacy state",
      commandPath: ["message"],
      expectedDoctorCalls: 1,
    },
  ])("$name", async ({ commandPath, expectedDoctorCalls }) => {
    await runEnsureConfigReady(commandPath);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(expectedDoctorCalls);
    if (expectedDoctorCalls > 0) {
      expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
        migrateState: true,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
    }
  });

  it("runs doctor flow when lightweight startup detection finds legacy state", async () => {
    const root = useTempOpenClawHome();
    writeLegacyTaskSidecarMarker(root);

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when lightweight startup detection finds legacy state", async () => {
    const root = useTempOpenClawHome();
    writeLegacyTaskSidecarMarker(root);

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("skips doctor flow for gateway run when debug proxy db points at shared state", async () => {
    const root = useTempOpenClawHome();
    const sharedStateDb = path.join(root, ".openclaw", "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(sharedStateDb), { recursive: true });
    fs.writeFileSync(sharedStateDb, "");
    setTestEnvValue("OPENCLAW_DEBUG_PROXY_DB_PATH", sharedStateDb);

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("skips doctor flow for gateway run when only the current canonical agents directory exists", async () => {
    const root = useTempOpenClawHome();
    fs.mkdirSync(path.join(root, ".openclaw", "agents", "main", "sessions"), { recursive: true });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("skips doctor flow for gateway run when configured custom session store has no legacy state", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, "custom-sessions.json");
    fs.writeFileSync(storePath, JSON.stringify({}));
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { store: storePath } },
      runtimeConfig: { session: { store: storePath } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("runs doctor flow for gateway run when the canonical session store has legacy keys", async () => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, "agents/main/sessions/sessions.json");
    const storePath = path.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        main: { sessionId: "abc", updatedAt: 1 },
      }),
    );

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when the canonical session store is JSON5 with legacy keys", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      "{\n  // operator-edited legacy store\n  main: { sessionId: 'abc', updatedAt: 1 }\n}\n",
    );

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when a non-default discovered session store has legacy keys", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "work", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({ main: { sessionId: "abc", updatedAt: 1 } }));

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when Telegram session sidecars exist", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{}");
    fs.writeFileSync(`${storePath}.telegram-messages.json`, JSON.stringify({ version: 1 }));

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when Telegram sidecars exist without sessions json", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(`${storePath}.telegram-sent-messages.json`, JSON.stringify({ version: 1 }));

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when Telegram named-account sidecars exist", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "ops", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(`${storePath}.telegram-topic-names.json`, JSON.stringify({ version: 1 }));
    const snapshot = {
      ...makeSnapshot(),
      config: { channels: { telegram: { accounts: { ops: {} } } } },
      runtimeConfig: { channels: { telegram: { accounts: { ops: {} } } } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when canonical session entries contain ACP metadata", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "abc",
          updatedAt: 1,
          acp: { threadId: "thread-1", provider: "fixture" },
        },
      }),
    );

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when global scope makes agent main key legacy", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "abc", updatedAt: 1 },
      }),
    );
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { scope: "global" } },
      runtimeConfig: { session: { scope: "global" } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("skips doctor flow for gateway run when current sessionFile path is already valid", async () => {
    const root = useTempOpenClawHome();
    const sessionsDir = path.join(root, ".openclaw", "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const transcriptPath = path.join(sessionsDir, "abc.jsonl");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: "session", id: "abc" }) + "\n");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "abc", updatedAt: 1, sessionFile: transcriptPath },
      }),
    );

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("runs doctor flow for gateway run when a shared session store has a later agent legacy key", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, "shared-sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:work:main": { sessionId: "abc", updatedAt: 1 },
      }),
    );
    const snapshot = {
      ...makeSnapshot(),
      config: {
        session: { store: storePath, scope: "global" },
        agents: { list: [{ id: "main" }, { id: "work" }] },
      },
      runtimeConfig: {
        session: { store: storePath, scope: "global" },
        agents: { list: [{ id: "main" }, { id: "work" }] },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("skips doctor flow for gateway run when shared session store has current cross-agent keys", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, "shared-sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "abc", updatedAt: 1 },
      }),
    );
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { store: storePath }, agents: { list: [{ id: "main" }, { id: "work" }] } },
      runtimeConfig: {
        session: { store: storePath },
        agents: { list: [{ id: "main" }, { id: "work" }] },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("runs doctor flow for gateway run when shared non-main store has orphan main keys", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, "shared-sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "abc", updatedAt: 1 },
      }),
    );
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { store: storePath }, agents: { list: [{ id: "work" }] } },
      runtimeConfig: { session: { store: storePath }, agents: { list: [{ id: "work" }] } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when shared work-ops store has orphan main keys", async () => {
    const root = useTempOpenClawHome();
    const storePath = path.join(root, "shared-sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "abc", updatedAt: 1 },
      }),
    );
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { store: storePath }, agents: { list: [{ id: "work" }, { id: "ops" }] } },
      runtimeConfig: {
        session: { store: storePath },
        agents: { list: [{ id: "work" }, { id: "ops" }] },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it.each([
    ["legacy delivery queue", "delivery-queue/pending.json"],
    ["plugin-owned active memory state", "plugins/active-memory/session-toggles.json"],
    ["plugin-owned phone control state", "plugins/phone-control/armed.json"],
    ["ACPX process leases", "acpx/process-leases.json"],
    ["ACPX gateway instance", "gateway-instance-id"],
    ["Device Pair notify state", "device-pair-notify.json"],
    ["Matrix state", "matrix/default/storage-meta.json"],
    ["Nostr state", "nostr/bus-state-default.json"],
    ["MSTeams conversations", "msteams-conversations.json"],
  ])("runs doctor flow for gateway run when %s exists", async (_label, relativePath) => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, relativePath);

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("detects MSTeams feedback-learning files in configured session store paths", () => {
    const root = useTempOpenClawHome();
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions");
    writeMSTeamsLearningMarker(path.join(root, "stores", "work", "sessions"));

    expect(
      testApi.hasMSTeamsFeedbackLearningLegacyStateForTests({
        session: { store: storeTemplate },
        agents: { list: [{ id: "work" }] },
      }),
    ).toBe(true);
  });

  it("detects MSTeams feedback-learning files when the configured store path itself ends in json", () => {
    const root = useTempOpenClawHome();
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions.json");
    writeMSTeamsLearningMarker(path.join(root, "stores", "work", "sessions.json"));

    expect(
      testApi.hasMSTeamsFeedbackLearningLegacyStateForTests({
        session: { store: storeTemplate },
        agents: { list: [{ id: "work" }] },
      }),
    ).toBe(true);
  });

  it("normalizes agent ids when detecting MSTeams feedback-learning files", () => {
    const root = useTempOpenClawHome();
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions");
    writeMSTeamsLearningMarker(path.join(root, "stores", "sales-team", "sessions"));

    expect(
      testApi.hasMSTeamsFeedbackLearningLegacyStateForTests({
        session: { store: storeTemplate },
        agents: { list: [{ id: "Sales Team" }] },
      }),
    ).toBe(true);
  });

  it("ignores sibling MSTeams feedback-learning files when the configured store is a json file", () => {
    const root = useTempOpenClawHome();
    const storeDir = path.join(root, "stores", "main");
    writeMSTeamsLearningMarker(storeDir);

    expect(
      testApi.hasMSTeamsFeedbackLearningLegacyStateForTests({
        session: { store: path.join(root, "stores", "{agentId}", "sessions.json") },
      }),
    ).toBe(false);
  });

  it("ignores archived MSTeams feedback-learning files in session store paths", () => {
    const root = useTempOpenClawHome();
    const storeDir = path.join(root, "stores", "main", "sessions");
    writeMSTeamsLearningMarker(storeDir, "bXN0ZWFtczp1c2VyMQ.learnings.json.migrated");

    expect(
      testApi.hasMSTeamsFeedbackLearningLegacyStateForTests({
        session: { store: path.join(root, "stores", "{agentId}", "sessions") },
      }),
    ).toBe(false);
  });

  it("runs doctor flow for gateway run when MSTeams feedback-learning legacy files exist", async () => {
    const root = useTempOpenClawHome();
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions");
    writeMSTeamsLearningMarker(path.join(root, "stores", "work", "sessions"));
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { store: storeTemplate }, agents: { list: [{ id: "work" }] } },
      runtimeConfig: { session: { store: storeTemplate }, agents: { list: [{ id: "work" }] } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when configured Memory Core workspace state exists", async () => {
    const root = useTempOpenClawHome();
    const workspace = path.join(root, "custom-workspace");
    const markerPath = path.join(workspace, "memory", ".dreams", "daily-ingestion.json");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
    const snapshot = {
      ...makeSnapshot(),
      config: { agents: { defaults: { workspace } } },
      runtimeConfig: { agents: { defaults: { workspace } } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when canonicalized agent workspace has Memory Core state", async () => {
    const root = useTempOpenClawHome();
    const markerPath = path.join(
      root,
      ".openclaw",
      "workspace-sales-team",
      "memory",
      ".dreams",
      "daily-ingestion.json",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
    const snapshot = {
      ...makeSnapshot(),
      config: { agents: { list: [{ id: "main", default: true }, { id: "Sales Team" }] } },
      runtimeConfig: { agents: { list: [{ id: "main", default: true }, { id: "Sales Team" }] } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when mixed-case profile workspace has Memory Core state", async () => {
    const root = useTempOpenClawHome();
    setTestEnvValue("OPENCLAW_PROFILE", "Work");
    const markerPath = path.join(
      root,
      ".openclaw",
      "workspace-Work",
      "memory",
      ".dreams",
      "phase-signals.json",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when OPENCLAW_WORKSPACE_DIR has Memory Core state", async () => {
    const root = useTempOpenClawHome();
    const workspace = path.join(root, "env-workspace");
    setTestEnvValue("OPENCLAW_WORKSPACE_DIR", workspace);
    const markerPath = path.join(workspace, "memory", ".dreams", "session-ingestion.json");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when a derived agent workspace has Memory Core state", async () => {
    const root = useTempOpenClawHome();
    const stateDir = path.join(root, "custom-state");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const markerPath = path.join(
      stateDir,
      "workspace-main",
      "memory",
      ".dreams",
      "short-term-recall.json",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
    const snapshot = {
      ...makeSnapshot(),
      config: { agents: { list: [{ id: "main" }, { id: "ops", default: true }] } },
      runtimeConfig: { agents: { list: [{ id: "main" }, { id: "ops", default: true }] } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when configured Memory Wiki vault state exists", async () => {
    const root = useTempOpenClawHome();
    const vault = path.join(root, "wiki-vault");
    const markerPath = path.join(vault, ".openclaw-wiki", "source-sync.json");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
    const snapshot = {
      ...makeSnapshot(),
      config: { plugins: { entries: { "memory-wiki": { config: { vault: { path: vault } } } } } },
      runtimeConfig: {
        plugins: { entries: { "memory-wiki": { config: { vault: { path: vault } } } } },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when OS-home default Memory Wiki vault state exists", async () => {
    const openclawHome = useTempOpenClawHome();
    const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-wiki-home-"));
    tempRoots.push(osHome);
    setTestEnvValue("HOME", osHome);
    expect(openclawHome).not.toBe(osHome);
    const markerPath = path.join(
      osHome,
      ".openclaw",
      "wiki",
      "main",
      ".openclaw-wiki",
      "source-sync.json",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when configured tilde Voice Call store exists under OS home", async () => {
    const openclawHome = useTempOpenClawHome();
    const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-voice-home-"));
    tempRoots.push(osHome);
    setTestEnvValue("HOME", osHome);
    expect(openclawHome).not.toBe(osHome);
    const markerPath = path.join(osHome, "voice-calls", "calls.jsonl");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}\n");
    const snapshot = {
      ...makeSnapshot(),
      config: {
        plugins: {
          entries: {
            "voice-call": {
              config: { store: "~/voice-calls" },
            },
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            "voice-call": {
              config: { store: "~/voice-calls" },
            },
          },
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when configured Voice Call legacy store exists", async () => {
    const root = useTempOpenClawHome();
    const store = path.join(root, "custom-voice-calls");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "calls.jsonl"), "{}\n");
    const snapshot = {
      ...makeSnapshot(),
      config: {
        plugins: {
          entries: {
            "@openclaw/voice-call": {
              config: { store },
            },
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            "@openclaw/voice-call": {
              config: { store },
            },
          },
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
      snapshot,
      baseConfig: {},
    });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when OS-home Voice Call legacy store exists", async () => {
    const openclawHome = useTempOpenClawHome();
    const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-os-home-"));
    tempRoots.push(osHome);
    setTestEnvValue("HOME", osHome);
    expect(openclawHome).not.toBe(osHome);
    const markerPath = path.join(osHome, ".openclaw", "voice-calls", "calls.jsonl");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}\n");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("skips doctor flow for gateway run when Voice Call file exists only under OPENCLAW_HOME", async () => {
    const openclawHome = useTempOpenClawHome();
    const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-os-home-empty-"));
    tempRoots.push(osHome);
    setTestEnvValue("HOME", osHome);
    expect(openclawHome).not.toBe(osHome);
    writeStateMarker(openclawHome, "voice-calls/calls.jsonl");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("runs doctor flow for gateway run when Workboard legacy plugin KV exists", async () => {
    const root = useTempOpenClawHome();
    writeWorkboardLegacyKvMarker(root);

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when Telegram legacy plugin KV exists", async () => {
    const root = useTempOpenClawHome();
    writePluginStateKvMarker(root, "telegram", "telegram.message-dispatch-dedupe");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("skips doctor flow for gateway run when only current plugin KV exists", async () => {
    const root = useTempOpenClawHome();
    writePluginStateKvMarker(root, "demo-plugin", "current-state");

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    ["plugin", "plugins/active-memory/session-toggles.json.migrated"],
    ["Matrix", "matrix/default/storage-meta.json.migrated"],
    ["Nostr", "nostr/bus-state-default.json.migrated"],
  ])(
    "skips doctor flow for gateway run when %s migration source is already archived",
    async (_label, relativePath) => {
      const root = useTempOpenClawHome();
      writeStateMarker(root, relativePath);

      await runEnsureConfigReady(["gateway", "run"]);

      expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
    },
  );

  it("runs doctor flow when lightweight startup detection finds a pending SQLite archive", async () => {
    const root = useTempOpenClawHome();
    writePendingTaskSidecarArchiveMarker(root);

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for legacy sessions without task sidecars", async () => {
    const root = useTempOpenClawHome();
    fs.mkdirSync(path.join(root, ".openclaw", "sessions"), { recursive: true });

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it("runs doctor flow before agent commands when the legacy plugin install index exists", async () => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, "plugins/installs.json");

    await runEnsureConfigReady(["agent"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow before agent commands when default exec approvals must move to a custom state dir", async () => {
    const root = useTempOpenClawHome();
    const stateDir = path.join(root, "custom-state");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    writeStateMarker(root, "exec-approvals.json");

    await runEnsureConfigReady(["agent"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it.each([
    ["Discord model picker preferences", "discord/model-picker-preferences.json"],
    ["Discord thread bindings", "discord/thread-bindings.json"],
    ["Feishu dedupe sidecar", "feishu/dedup/default.json"],
    ["Telegram bot info cache", "telegram/bot-info-default.json"],
    ["Telegram update offset", "telegram/update-offset-default.json"],
    ["Telegram sticker cache", "telegram/sticker-cache.json"],
    ["Telegram thread bindings", "telegram/thread-bindings-default.json"],
    ["Telegram pairing allowFrom", "credentials/telegram-allowFrom.json"],
    ["iMessage reply short-id cache", "imessage/reply-cache.jsonl"],
    ["iMessage sent echo cache", "imessage/sent-echoes.jsonl"],
    ["iMessage catchup cursor", "imessage/catchup/default__37a8eec1ce19.json"],
    ["WhatsApp root auth", "credentials/creds.json"],
  ])("runs doctor flow for bundled channel legacy state: %s", async (_label, relativePath) => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, relativePath);

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it("uses shared tilde expansion for OPENCLAW_HOME in the startup detector", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-home-"));
    tempRoots.push(root);
    setTestEnvValue("HOME", root);
    setTestEnvValue("OPENCLAW_HOME", "~/svc");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    writeLegacyTaskSidecarMarker(path.join(root, "svc"));

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["legacy cron jobs", "cron/jobs.json"],
    ["legacy cron state", "cron/jobs-state.json"],
    ["legacy cron run log", "cron/runs/job-1.jsonl"],
  ])("runs doctor flow for gateway run when default %s exists", async (_label, relativePath) => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, relativePath);

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for gateway run when configured cron legacy store exists", async () => {
    const root = useTempOpenClawHome();
    const store = path.join(root, "custom-cron", "jobs.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, "{}");
    const snapshot = {
      ...makeSnapshot(),
      config: { cron: { store } },
      runtimeConfig: { cron: { store } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({ snapshot, baseConfig: {} });

    await runEnsureConfigReady(["gateway", "run"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });
  });

  it("runs doctor flow for read-only commands with configured custom session stores", async () => {
    const root = useTempOpenClawHome();
    const customStore = path.join(root, "sessions", "sessions.json");
    const snapshot = {
      ...makeSnapshot(),
      config: { session: { store: customStore } },
      runtimeConfig: { session: { store: customStore } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
      snapshot,
      baseConfig: {},
    });

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it("pins a valid preflight snapshot for command code reuse", async () => {
    const snapshot = {
      ...makeSnapshot(),
      config: { runtime: true },
      runtimeConfig: { runtime: true, materialized: true },
      sourceConfig: { source: true },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);

    await runEnsureConfigReady(["health"]);

    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      snapshot.runtimeConfig,
      snapshot.sourceConfig,
    );
  });

  it("retries the cached config snapshot after a read rejection", async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = "false";
    const transientError = new Error("temporary config read failure");
    const recoveredSnapshot = makeSnapshot();
    readConfigFileSnapshotMock
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(recoveredSnapshot);

    try {
      await expect(runEnsureConfigReady(["health"])).rejects.toThrow(transientError);
      await expect(runEnsureConfigReady(["health"])).resolves.toBeDefined();
      await expect(runEnsureConfigReady(["health"])).resolves.toBeDefined();
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(undefined, undefined);
  });

  it("exits for invalid config on non-allowlisted commands", async () => {
    setInvalidSnapshot();
    const runtime = await runEnsureConfigReady(["message"]);

    expect(plainErrorCalls(runtime)).toEqual([
      "OpenClaw config is invalid",
      "File: /tmp/openclaw.json",
      "Problem:",
      "  - channels.quietchat: invalid",
      "",
      `Fix: ${formatCliCommand("openclaw doctor --fix")}`,
      `Inspect: ${formatCliCommand("openclaw config validate")}`,
      "Status, health, logs, tasks list/audit, and doctor commands still run with invalid config.",
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("replaces doctor fix advice for plugin packaging-only invalid config", async () => {
    setInvalidSnapshot({
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
    });
    const runtime = await runEnsureConfigReady(["message"]);
    const calls = plainErrorCalls(runtime);

    expect(calls).toContain(`Fix: ${pluginPackagingRecoveryHint}`);
    expect(calls).not.toContain(`Fix: ${formatCliCommand("openclaw doctor --fix")}`);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not exit for invalid config on allowlisted commands", async () => {
    setInvalidSnapshot({
      issues: [{ path: "agents.defaults", message: 'Unrecognized key: "agentRuntime"' }],
    });
    const statusRuntime = await runEnsureConfigReady(["status"]);
    expect(statusRuntime.exit).not.toHaveBeenCalled();

    const bareGatewayRuntime = await runEnsureConfigReady(["gateway"]);
    expect(bareGatewayRuntime.exit).not.toHaveBeenCalled();

    const gatewayRunRuntime = await runEnsureConfigReady(["gateway", "run"]);
    expect(gatewayRunRuntime.exit).not.toHaveBeenCalled();

    const gatewayRuntime = await runEnsureConfigReady(["gateway", "health"]);
    expect(gatewayRuntime.exit).not.toHaveBeenCalled();

    const tasksListRuntime = await runEnsureConfigReady(["tasks", "list"]);
    expect(tasksListRuntime.exit).not.toHaveBeenCalled();

    const tasksParentRuntime = await runEnsureConfigReady(["tasks"]);
    expect(tasksParentRuntime.exit).not.toHaveBeenCalled();

    const tasksAuditRuntime = await runEnsureConfigReady(["tasks", "audit"]);
    expect(tasksAuditRuntime.exit).not.toHaveBeenCalled();

    const tasksRunRuntime = await runEnsureConfigReady(["tasks", "run"]);
    expect(tasksRunRuntime.exit).toHaveBeenCalledWith(1);

    const doctorRuntime = await runEnsureConfigReady(["doctor", "fix"]);
    expect(doctorRuntime.exit).not.toHaveBeenCalled();
    expect(doctorRuntime.error).toHaveBeenCalledWith(expect.stringContaining("agentRuntime"));
  });

  it("allows an explicit invalid-config override", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    await ensureConfigReady({
      runtime: runtime as never,
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("runs doctor migration flow only once per module instance", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    const runtimeA = makeRuntime();
    const runtimeB = makeRuntime();

    await ensureConfigReady({ runtime: runtimeA as never, commandPath: ["message"] });
    await ensureConfigReady({ runtime: runtimeB as never, commandPath: ["message"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("still runs doctor flow when stdout suppression is enabled", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    await runEnsureConfigReady(["message"], true);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("prevents preflight note noise when suppression is enabled", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      note("Doctor warnings", "Config warnings");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], true);
    });
    expect(output).not.toContain("Doctor warnings");
  });

  it("allows preflight note noise when suppression is not enabled", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      note("Doctor warnings", "Config warnings");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], false);
    });
    expect(output).toContain("Doctor warnings");
  });

  it("does not suppress unrelated concurrent stdout writes while suppressing preflight notes", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    let releasePreflight: (() => void) | undefined;
    let preflightStarted: (() => void) | undefined;
    const preflightStartedPromise = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    const releasePreflightPromise = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      note("Doctor warnings", "Config warnings");
      preflightStarted?.();
      await releasePreflightPromise;
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });

    let callbackCalled = false;
    const output = await withCapturedStdout(async () => {
      const ready = runEnsureConfigReady(["message"], true);
      await preflightStartedPromise;
      process.stdout.write("Concurrent output\n", () => {
        callbackCalled = true;
      });
      releasePreflight?.();
      await ready;
    });

    expect(output).toContain("Concurrent output");
    expect(output).not.toContain("Doctor warnings");
    expect(callbackCalled).toBe(true);
  });
});
