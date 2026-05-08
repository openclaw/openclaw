import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSqliteSessionEntries } from "../config/sessions/store-backend.sqlite.js";
import { loadSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import {
  createCorePluginStateKeyedStore,
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";

let tempRoots: string[] = [];

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  function fileExists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  function detectWhatsAppLegacyStateMigrations(params: { oauthDir: string }) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(params.oauthDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const isLegacyAuthFile =
        entry.name === "creds.json" ||
        entry.name === "creds.json.bak" ||
        (/^(app-state-sync|session|sender-key|pre-key)-/.test(entry.name) &&
          entry.name.endsWith(".json"));
      if (!entry.isFile() || entry.name === "oauth.json" || !isLegacyAuthFile) {
        return [];
      }
      const sourcePath = path.join(params.oauthDir, entry.name);
      const targetPath = path.join(params.oauthDir, "whatsapp", "default", entry.name);
      return fileExists(targetPath)
        ? []
        : [{ kind: "move" as const, label: `WhatsApp auth ${entry.name}`, sourcePath, targetPath }];
    });
  }

  return {
    ...actual,
    listBundledChannelLegacySessionSurfaces: vi.fn(() => [
      {
        isLegacyGroupSessionKey: (key: string) => /^group:.+@g\.us$/i.test(key.trim()),
        canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
          /^group:.+@g\.us$/i.test(key.trim())
            ? `agent:${agentId}:whatsapp:${key.trim().toLowerCase()}`
            : null,
      },
    ]),
    listBundledChannelLegacyStateMigrationDetectors: vi.fn(() => [
      ({ oauthDir }: { oauthDir: string }) => detectWhatsAppLegacyStateMigrations({ oauthDir }),
    ]),
    listBundledChannelSetupPluginsByFeature: vi.fn((feature: string) => {
      if (feature === "legacySessionSurfaces") {
        return [
          {
            id: "whatsapp",
            messaging: {
              isLegacyGroupSessionKey: (key: string) => /^group:.+@g\.us$/i.test(key.trim()),
              canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) =>
                /^group:.+@g\.us$/i.test(key.trim())
                  ? `agent:${agentId}:whatsapp:${key.trim().toLowerCase()}`
                  : null,
            },
          },
        ];
      }
      if (feature === "legacyStateMigrations") {
        return [
          {
            id: "whatsapp",
            lifecycle: {
              detectLegacyStateMigrations: ({ oauthDir }: { oauthDir: string }) =>
                detectWhatsAppLegacyStateMigrations({ oauthDir }),
            },
          },
        ];
      }
      return [];
    }),
  };
});

vi.mock("../infra/json-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/json-files.js")>("../infra/json-files.js");
  return {
    ...actual,
    writeTextAtomic: async (
      filePath: string,
      content: string,
      options?: { mode?: number; dirMode?: number; trailingNewline?: boolean },
    ) => {
      const payload =
        options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
        ...(typeof options?.dirMode === "number" ? { mode: options.dirMode } : {}),
      });
      await fs.promises.writeFile(filePath, payload, {
        encoding: "utf8",
        mode: options?.mode ?? 0o600,
      });
    },
  };
});

async function makeTempRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-"));
  tempRoots.push(root);
  return root;
}

async function makeRootWithEmptyCfg() {
  const root = await makeTempRoot();
  const cfg: OpenClawConfig = {};
  return { root, cfg };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPluginStateStoreForTests();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  await Promise.all(
    tempRoots.map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeLegacySessionsFixture(params: {
  root: string;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
  transcripts?: Record<string, string>;
}) {
  const legacySessionsDir = path.join(params.root, "sessions");
  fs.mkdirSync(legacySessionsDir, { recursive: true });
  writeJson5(path.join(legacySessionsDir, "sessions.json"), params.sessions);
  for (const [fileName, content] of Object.entries(params.transcripts ?? {})) {
    fs.writeFileSync(path.join(legacySessionsDir, fileName), content, "utf-8");
  }
  return legacySessionsDir;
}

async function detectAndRunMigrations(params: {
  root: string;
  cfg: OpenClawConfig;
  now?: () => number;
}) {
  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  });
  await runLegacyStateMigrations({ detected, now: params.now });
}

function readSessionsStore(params: { root: string; targetDir: string }) {
  const agentId = path.basename(path.dirname(params.targetDir));
  return loadSqliteSessionEntries({
    agentId,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
  }) as Record<string, { sessionId: string }>;
}

async function runAndReadSessionsStore(params: {
  root: string;
  cfg: OpenClawConfig;
  targetDir: string;
  now?: () => number;
}) {
  await detectAndRunMigrations({
    root: params.root,
    cfg: params.cfg,
    now: params.now,
  });
  return readSessionsStore({ root: params.root, targetDir: params.targetDir });
}

type StateDirMigrationResult = Awaited<ReturnType<typeof autoMigrateLegacyStateDir>>;

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function getStateDirMigrationPaths(root: string) {
  return {
    targetDir: path.join(root, ".openclaw"),
    legacyDir: path.join(root, ".clawdbot"),
  };
}

function ensureLegacyAndTargetStateDirs(root: string) {
  const paths = getStateDirMigrationPaths(root);
  fs.mkdirSync(paths.targetDir, { recursive: true });
  fs.mkdirSync(paths.legacyDir, { recursive: true });
  return paths;
}

async function runStateDirMigration(root: string, env = {} as NodeJS.ProcessEnv) {
  return autoMigrateLegacyStateDir({
    env,
    homedir: () => root,
  });
}

async function runFreshStateDirMigration(root: string, env = {} as NodeJS.ProcessEnv) {
  resetAutoMigrateLegacyStateDirForTest();
  return runStateDirMigration(root, env);
}

async function runAutoMigrateLegacyStateWithLog(params: {
  root: string;
  cfg: OpenClawConfig;
  now?: () => number;
}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const result = await autoMigrateLegacyState({
    cfg: params.cfg,
    env: { OPENCLAW_STATE_DIR: params.root } as NodeJS.ProcessEnv,
    log,
    now: params.now,
  });
  return { result, log };
}

function expectTargetAlreadyExistsWarning(result: StateDirMigrationResult, targetDir: string) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toEqual([
    `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
  ]);
}

function expectUnmigratedWithoutWarnings(result: StateDirMigrationResult) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toStrictEqual([]);
}

function writeLegacyAgentFiles(root: string, files: Record<string, string>) {
  const legacyAgentDir = path.join(root, "agent");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(legacyAgentDir, fileName), content, "utf-8");
  }
  return legacyAgentDir;
}

function ensureCredentialsDir(root: string) {
  const oauthDir = path.join(root, "credentials");
  fs.mkdirSync(oauthDir, { recursive: true });
  return oauthDir;
}

describe("doctor legacy state migrations", () => {
  it("migrates legacy config audit JSONL into SQLite plugin state", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const auditDir = path.join(root, "logs");
    fs.mkdirSync(auditDir, { recursive: true });
    const sourcePath = path.join(auditDir, "config-audit.jsonl");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        ts: "2026-05-01T12:00:00.000Z",
        source: "config-io",
        event: "config.write",
        result: "rename",
        configPath: "/tmp/openclaw.json",
        nextHash: "next-hash",
      })}\n`,
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.channelPlans.plans.some((plan) => plan.label === "Config audit log")).toBe(
      true,
    );

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const auditStore = createCorePluginStateKeyedStore<Record<string, unknown>>({
      ownerId: "core:config",
      namespace: "audit",
      maxEntries: 50_000,
    });

    expect(result.changes.join("\n")).toContain(
      "Imported 1 config audit record(s) into SQLite plugin state",
    );
    await expect(auditStore.entries()).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          event: "config.write",
          result: "rename",
          configPath: "/tmp/openclaw.json",
          nextHash: "next-hash",
        }),
      }),
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("migrates legacy file-transfer audit JSONL into SQLite plugin state", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const auditDir = path.join(root, "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    const sourcePath = path.join(auditDir, "file-transfer.jsonl");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        timestamp: "2026-05-01T12:00:00.000Z",
        op: "file.fetch",
        nodeId: "node-1",
        requestedPath: "/tmp/input.txt",
        canonicalPath: "/private/tmp/input.txt",
        decision: "allowed",
        sizeBytes: 42,
        sha256: "abc123",
      })}\n`,
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      detected.channelPlans.plans.some((plan) => plan.label === "File transfer audit log"),
    ).toBe(true);

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const auditStore = createPluginStateKeyedStore<Record<string, unknown>>("file-transfer", {
      namespace: "audit",
      maxEntries: 50_000,
    });

    expect(result.changes.join("\n")).toContain(
      "Imported 1 file-transfer audit record(s) into SQLite plugin state",
    );
    await expect(auditStore.entries()).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          op: "file.fetch",
          nodeId: "node-1",
          requestedPath: "/tmp/input.txt",
          decision: "allowed",
          sizeBytes: 42,
          sha256: "abc123",
        }),
      }),
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("migrates legacy Crestodian audit JSONL into SQLite plugin state", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const auditDir = path.join(root, "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    const sourcePath = path.join(auditDir, "crestodian.jsonl");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        timestamp: "2026-05-01T12:00:00.000Z",
        operation: "config.set",
        summary: "Set config gateway.port",
        configPath: "/tmp/openclaw.json",
        details: { path: "gateway.port" },
      })}\n`,
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.channelPlans.plans.some((plan) => plan.label === "Crestodian audit log")).toBe(
      true,
    );

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const auditStore = createCorePluginStateKeyedStore<Record<string, unknown>>({
      ownerId: "core:crestodian",
      namespace: "audit",
      maxEntries: 50_000,
    });

    expect(result.changes.join("\n")).toContain(
      "Imported 1 Crestodian audit record(s) into SQLite plugin state",
    );
    await expect(auditStore.entries()).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          operation: "config.set",
          summary: "Set config gateway.port",
          details: { path: "gateway.port" },
        }),
      }),
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("migrates legacy Phone Control arm state into SQLite plugin state", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const stateDir = path.join(root, "plugins", "phone-control");
    fs.mkdirSync(stateDir, { recursive: true });
    const sourcePath = path.join(stateDir, "armed.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        version: 2,
        armedAtMs: 1_774_000_000_000,
        expiresAtMs: 1_774_000_600_000,
        group: "writes",
        armedCommands: ["sms.send"],
        addedToAllow: ["sms.send"],
        removedFromDeny: ["sms.send"],
      })}\n`,
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      detected.channelPlans.plans.some((plan) => plan.label === "Phone Control arm state"),
    ).toBe(true);

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const armStore = createPluginStateKeyedStore<Record<string, unknown>>("phone-control", {
      namespace: "arm-state",
      maxEntries: 4,
    });

    expect(result.changes.join("\n")).toContain(
      "Imported Phone Control arm state into SQLite plugin state",
    );
    await expect(armStore.lookup("current")).resolves.toMatchObject({
      group: "writes",
      armedCommands: ["sms.send"],
      addedToAllow: ["sms.send"],
      removedFromDeny: ["sms.send"],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("migrates legacy ClawHub skill tracking into SQLite plugin state", async () => {
    const root = await makeTempRoot();
    const workspaceDir = path.join(root, "workspace");
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const slug = "agentreceipt";
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const originPath = path.join(workspaceDir, "skills", slug, ".clawhub", "origin.json");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(path.dirname(originPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        skills: {
          [slug]: {
            version: "0.9.0",
            installedAt: 123,
          },
        },
      })}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      originPath,
      `${JSON.stringify({
        version: 1,
        registry: "https://legacy.clawhub.ai",
        slug,
        installedVersion: "0.9.0",
        installedAt: 123,
      })}\n`,
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      detected.channelPlans.plans.some((plan) => plan.label === "ClawHub skill install tracking"),
    ).toBe(true);

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const installStore = createCorePluginStateKeyedStore<Record<string, unknown>>({
      ownerId: "core:clawhub-skills",
      namespace: "skill-installs",
      maxEntries: 10_000,
    });

    expect(result.changes.join("\n")).toContain(
      "Imported 1 ClawHub skill install record(s) into SQLite plugin state",
    );
    await expect(installStore.entries()).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          registry: "https://legacy.clawhub.ai",
          slug,
          installedVersion: "0.9.0",
          workspaceDir: path.resolve(workspaceDir),
          targetDir: path.join(workspaceDir, "skills", slug),
        }),
      }),
    ]);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(originPath)).toBe(false);
  });

  it("migrates legacy Crestodian rescue pending approvals into SQLite plugin state", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const pendingDir = path.join(root, "crestodian", "rescue-pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    const sourcePath = path.join(pendingDir, "abc123.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        id: "pending-1",
        createdAt: "2026-05-01T12:00:00.000Z",
        expiresAt: "2026-05-01T12:10:00.000Z",
        operation: { kind: "gateway-restart" },
        auditDetails: { rescue: true, channel: "whatsapp" },
      })}\n`,
      "utf-8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      detected.channelPlans.plans.some(
        (plan) => plan.label === "Crestodian rescue pending approvals",
      ),
    ).toBe(true);

    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });
    const pendingStore = createCorePluginStateKeyedStore<Record<string, unknown>>({
      ownerId: "core:crestodian",
      namespace: "rescue-pending",
      maxEntries: 10_000,
    });

    expect(result.changes.join("\n")).toContain(
      "Imported 1 Crestodian rescue pending approval(s) into SQLite plugin state",
    );
    await expect(pendingStore.lookup("abc123")).resolves.toMatchObject({
      id: "pending-1",
      operation: { kind: "gateway-restart" },
      auditDetails: { rescue: true, channel: "whatsapp" },
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("migrates legacy sessions into agents/<id>/sessions", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
        "slack:channel:C123": { sessionId: "c", updatedAt: 30 },
        "group:abc": { sessionId: "d", updatedAt: 40 },
        "subagent:xyz": { sessionId: "e", updatedAt: 50 },
      },
      transcripts: {
        "a.jsonl": `${JSON.stringify({
          type: "session",
          version: 3,
          id: "a",
          timestamp: "2026-04-25T00:00:00Z",
          cwd: root,
        })}\n`,
        "b.jsonl": `${JSON.stringify({
          type: "session",
          version: 3,
          id: "b",
          timestamp: "2026-04-25T00:00:00Z",
          cwd: root,
        })}\n`,
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 123,
    });

    expect(result.warnings).toStrictEqual([]);
    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "b.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(false);

    expect(fs.existsSync(path.join(targetDir, "sessions.json"))).toBe(false);
    const store = readSessionsStore({ root, targetDir });
    expect(store["agent:main:main"]?.sessionId).toBe("b");
    expect(store["agent:main:+1555"]?.sessionId).toBe("a");
    expect(store["agent:main:+1666"]?.sessionId).toBe("b");
    expect(store["+1555"]).toBeUndefined();
    expect(store["+1666"]).toBeUndefined();
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("c");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("d");
    expect(store["agent:main:subagent:xyz"]?.sessionId).toBe("e");
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "a",
        env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).toHaveLength(1);
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "b",
        env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).toHaveLength(1);
  });

  it("keeps shipped WhatsApp legacy group keys channel-qualified during migration", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");

    writeLegacySessionsFixture({
      root,
      sessions: {
        "group:123@g.us": { sessionId: "wa", updatedAt: 10 },
        "group:abc": { sessionId: "generic", updatedAt: 9 },
      },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });

    expect(store["agent:main:whatsapp:group:123@g.us"]?.sessionId).toBe("wa");
    expect(store["agent:main:unknown:group:abc"]?.sessionId).toBe("generic");
  });

  it("migrates legacy agent dir with conflict fallback", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    writeLegacyAgentFiles(root, {
      "foo.txt": "legacy",
      "baz.txt": "legacy2",
    });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "foo.txt"), "new", "utf-8");

    await detectAndRunMigrations({ root, cfg, now: () => 123 });

    expect(fs.readFileSync(path.join(targetAgentDir, "baz.txt"), "utf-8")).toBe("legacy2");
    const backupDir = path.join(root, "agents", "main", "agent.legacy-123");
    expect(fs.existsSync(path.join(backupDir, "foo.txt"))).toBe(true);
  });

  it("auto-migrates legacy agent dir on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    writeLegacyAgentFiles(root, { "auth.json": "{}" });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    expect(fs.existsSync(path.join(targetAgentDir, "auth.json"))).toBe(true);
    expect(result.migrated).toBe(true);
    expect(log.info).toHaveBeenCalled();
  });

  it("leaves legacy sessions for doctor on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const legacySessionsDir = writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
      transcripts: {
        "a.jsonl": "a",
      },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({
      root,
      cfg,
      now: () => 123,
    });

    expect(result.migrated).toBe(false);
    expect(log.info).not.toHaveBeenCalled();

    const targetDir = path.join(root, "agents", "main", "sessions");
    expect(fs.existsSync(path.join(targetDir, "a.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(legacySessionsDir, "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(legacySessionsDir, "sessions.json"))).toBe(true);
    expect(Object.keys(readSessionsStore({ root, targetDir }))).toHaveLength(0);
  });

  it("migrates legacy WhatsApp auth files without touching oauth.json", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const oauthDir = ensureCredentialsDir(root);
    fs.writeFileSync(path.join(oauthDir, "oauth.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "creds.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(oauthDir, "session-abc.json"), "{}", "utf-8");

    await detectAndRunMigrations({ root, cfg, now: () => 123 });

    const target = path.join(oauthDir, "whatsapp", "default");
    expect(fs.existsSync(path.join(target, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "session-abc.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(oauthDir, "creds.json"))).toBe(false);
  });

  it("no-ops when nothing detected", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected });
    expect(result.changes).toStrictEqual([]);
  });

  it("routes legacy state to the default agent entry", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "alpha", default: true }] },
    };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
      },
    });

    const targetDir = path.join(root, "agents", "alpha", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:alpha:main"]?.sessionId).toBe("a");
  });

  it("honors session.mainKey when seeding the direct-chat bucket", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = { session: { mainKey: "work" } };
    writeLegacySessionsFixture({
      root,
      sessions: {
        "+1555": { sessionId: "a", updatedAt: 10 },
        "+1666": { sessionId: "b", updatedAt: 20 },
      },
    });

    const targetDir = path.join(root, "agents", "main", "sessions");
    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("b");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("canonicalizes legacy main keys inside the target sessions store", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
      "agent:main:main": { sessionId: "fresh", updatedAt: 20 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["main"]).toBeUndefined();
    expect(store["agent:main:main"]?.sessionId).toBe("fresh");
  });

  it("prefers the newest entry when collapsing main aliases", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = { session: { mainKey: "work" } };
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": { sessionId: "legacy", updatedAt: 50 },
      "agent:main:work": { sessionId: "canonical", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:work"]?.sessionId).toBe("legacy");
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("lowercases agent session keys during canonicalization", async () => {
    const root = await makeTempRoot();
    const cfg: OpenClawConfig = {};
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:slack:channel:C123": { sessionId: "legacy", updatedAt: 10 },
    });

    const store = await runAndReadSessionsStore({
      root,
      cfg,
      targetDir,
      now: () => 123,
    });
    expect(store["agent:main:slack:channel:c123"]?.sessionId).toBe("legacy");
    expect(store["agent:main:slack:channel:C123"]).toBeUndefined();
  });

  it("leaves target sessions with legacy keys for doctor on startup", async () => {
    const { root, cfg } = await makeRootWithEmptyCfg();
    const targetDir = path.join(root, "agents", "main", "sessions");
    writeJson5(path.join(targetDir, "sessions.json"), {
      main: { sessionId: "legacy", updatedAt: 10 },
    });

    const { result, log } = await runAutoMigrateLegacyStateWithLog({ root, cfg });

    expect(result.migrated).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(targetDir, "sessions.json"))).toBe(true);
    expect(Object.keys(readSessionsStore({ root, targetDir }))).toHaveLength(0);
  });

  it("does nothing when no legacy state dir exists", async () => {
    const root = await makeTempRoot();
    const result = await runStateDirMigration(root);

    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("skips state dir migration when env override is set", async () => {
    const root = await makeTempRoot();
    const { legacyDir } = getStateDirMigrationPaths(root);
    fs.mkdirSync(legacyDir, { recursive: true });

    const result = await runStateDirMigration(root, {
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv);

    expect(result.skipped).toBe(true);
    expect(result.migrated).toBe(false);
  });

  it("classifies already-migrated symlink mirrors without warnings", async () => {
    const flatRoot = await makeTempRoot();
    const flat = ensureLegacyAndTargetStateDirs(flatRoot);
    fs.mkdirSync(path.join(flat.targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(flat.targetDir, "agent"), { recursive: true });
    fs.symlinkSync(
      path.join(flat.targetDir, "sessions"),
      path.join(flat.legacyDir, "sessions"),
      DIR_LINK_TYPE,
    );
    fs.symlinkSync(
      path.join(flat.targetDir, "agent"),
      path.join(flat.legacyDir, "agent"),
      DIR_LINK_TYPE,
    );
    expectUnmigratedWithoutWarnings(await runFreshStateDirMigration(flatRoot));

    const nestedRoot = await makeTempRoot();
    const nested = ensureLegacyAndTargetStateDirs(nestedRoot);
    fs.mkdirSync(path.join(nested.targetDir, "agents", "main"), { recursive: true });
    fs.mkdirSync(path.join(nested.legacyDir, "agents"), { recursive: true });
    fs.symlinkSync(
      path.join(nested.targetDir, "agents", "main"),
      path.join(nested.legacyDir, "agents", "main"),
      DIR_LINK_TYPE,
    );
    expectUnmigratedWithoutWarnings(await runFreshStateDirMigration(nestedRoot));
  });

  it("warns when target exists and legacy state is not a safe mirror", async () => {
    const emptyRoot = await makeTempRoot();
    const empty = ensureLegacyAndTargetStateDirs(emptyRoot);
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(emptyRoot), empty.targetDir);

    const fileRoot = await makeTempRoot();
    const file = ensureLegacyAndTargetStateDirs(fileRoot);
    fs.writeFileSync(path.join(file.legacyDir, "sessions.json"), "{}", "utf-8");
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(fileRoot), file.targetDir);

    const outsideRoot = await makeTempRoot();
    const outside = ensureLegacyAndTargetStateDirs(outsideRoot);
    const outsideDir = path.join(outsideRoot, ".outside-state");
    fs.mkdirSync(path.join(outside.targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(outside.legacyDir, "sessions"), DIR_LINK_TYPE);
    expectTargetAlreadyExistsWarning(
      await runFreshStateDirMigration(outsideRoot),
      outside.targetDir,
    );

    const brokenRoot = await makeTempRoot();
    const broken = ensureLegacyAndTargetStateDirs(brokenRoot);
    const targetSessionDir = path.join(broken.targetDir, "sessions");
    fs.mkdirSync(targetSessionDir, { recursive: true });
    fs.symlinkSync(targetSessionDir, path.join(broken.legacyDir, "sessions"), DIR_LINK_TYPE);
    fs.rmSync(targetSessionDir, { recursive: true, force: true });
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(brokenRoot), broken.targetDir);

    const secondHopRoot = await makeTempRoot();
    const secondHop = ensureLegacyAndTargetStateDirs(secondHopRoot);
    const secondHopOutsideDir = path.join(secondHopRoot, ".outside-state");
    fs.mkdirSync(secondHopOutsideDir, { recursive: true });
    const targetHop = path.join(secondHop.targetDir, "hop");
    fs.symlinkSync(secondHopOutsideDir, targetHop, DIR_LINK_TYPE);
    fs.symlinkSync(targetHop, path.join(secondHop.legacyDir, "sessions"), DIR_LINK_TYPE);
    expectTargetAlreadyExistsWarning(
      await runFreshStateDirMigration(secondHopRoot),
      secondHop.targetDir,
    );
  });
});
