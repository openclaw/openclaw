// Codex Install Assertions tests cover Codex plugin install E2E helpers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPathInside,
  findPackageJson,
  npmProjectRootForInstalledPackage,
} from "../../scripts/e2e/lib/codex-install-utils.mjs";
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const CODEX_ON_DEMAND_ASSERTIONS_SCRIPT = "scripts/e2e/lib/codex-on-demand/assertions.mjs";
const CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT =
  "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
// Frozen candidate deliberately differs from the trusted checkout pin.
const CODEX_VERSION = "0.152.1";
const tempDirs: string[] = [];
const tmpFixtureFiles = [
  "/tmp/openclaw-candidate-codex-package.json",
  "/tmp/openclaw-codex-agent.err",
  "/tmp/openclaw-codex-agent.json",
  "/tmp/openclaw-codex-followthrough.err",
  "/tmp/openclaw-codex-followthrough.json",
  "/tmp/openclaw-codex-inspect.json",
  "/tmp/openclaw-onboard.json",
  "/tmp/openclaw-plugins-list.json",
];

afterEach(() => {
  for (const file of tmpFixtureFiles) {
    rmSync(file, { force: true });
  }
  cleanupTempDirs(tempDirs);
});

function nodeOptionsWithoutExperimentalWarnings(): string {
  const current = process.env.NODE_OPTIONS ?? "";
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeAuthProfileStoreSqlite(stateDir: string) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE IF NOT EXISTS config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
      `,
    ).run(
      "authProfiles.store",
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      }),
      Date.now(),
    );
  } finally {
    db.close();
  }
}

function runCodexOnDemandAssertions(root: string) {
  return spawnSync(process.execPath, [CODEX_ON_DEMAND_ASSERTIONS_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
  });
}

function runCodexNpmPluginLiveAssertions(params: {
  root: string;
  marker: string;
  sessionId: string;
  modelRef: string;
  bindingStoreContract?: "legacy-sidecar" | "plugin-kv";
  sessionStoreContract?: "legacy-json" | "sqlite";
}) {
  return spawnSync(
    process.execPath,
    [
      CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT,
      "assert-agent-turn",
      params.marker,
      params.sessionId,
      params.modelRef,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(params.root, "home"),
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
        OPENCLAW_STATE_DIR: path.join(params.root, "state"),
        OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT:
          params.bindingStoreContract ?? "plugin-kv",
        OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT: params.sessionStoreContract ?? "sqlite",
      },
    },
  );
}

function runCodexNpmPluginLiveFollowthroughAssertions(params: {
  root: string;
  progressMarker: string;
  completeMarker: string;
  sessionId: string;
  modelRef: string;
  artifactPath: string;
  inputPaths: string[];
}) {
  return spawnSync(
    process.execPath,
    [
      CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT,
      "assert-followthrough",
      params.progressMarker,
      params.completeMarker,
      params.sessionId,
      params.modelRef,
      params.artifactPath,
      ...params.inputPaths,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(params.root, "home"),
        NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
        OPENCLAW_STATE_DIR: path.join(params.root, "state"),
        OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT: "plugin-kv",
        OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT: "sqlite",
      },
    },
  );
}

function writeCodexBindingStateSqlite(params: {
  stateDir: string;
  sessionKey: string;
  sessionId: string;
  storedSessionId?: string;
  threadId: string;
}) {
  const dbPath = path.join(params.stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
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
    const entryKey = `session-key:main:${createHash("sha256")
      .update(params.sessionKey)
      .digest("base64url")}`;
    db.prepare(
      `INSERT INTO plugin_state_entries (
         plugin_id, namespace, entry_key, value_json, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "codex",
      "app-server-thread-bindings",
      entryKey,
      JSON.stringify({
        version: 1,
        state: "active",
        sessionId: params.storedSessionId ?? params.sessionId,
        binding: {
          threadId: params.threadId,
          cwd: params.stateDir,
          model: "gpt-5.4",
          modelProvider: "codex",
        },
      }),
      Date.now(),
      null,
    );
  } finally {
    db.close();
  }
}

function writeSessionStoreSqlite(params: {
  stateDir: string;
  sessionId: string;
  sessionKey: string;
}) {
  const dbPath = path.join(params.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT NOT NULL PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_windows (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        agent_harness_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    const now = Date.now();
    db.prepare(
      `INSERT INTO session_windows (
         session_id, session_key, agent_harness_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(params.sessionId, params.sessionKey, "codex", now, now);
    db.prepare(
      `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      params.sessionKey,
      params.sessionId,
      JSON.stringify({
        sessionId: params.sessionId,
        agentHarnessId: "codex",
      }),
      now,
    );
    db.prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(params.sessionId, 0, '{"type":"session"}', now);
  } finally {
    db.close();
  }
}

function replaceSessionTranscriptMessages(params: {
  stateDir: string;
  sessionId: string;
  messages: unknown[];
}) {
  const dbPath = path.join(params.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const now = Date.now();
    db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(params.sessionId);
    const insert = db.prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run(params.sessionId, 0, '{"type":"session"}', now);
    params.messages.forEach((message, index) => {
      insert.run(
        params.sessionId,
        index + 1,
        JSON.stringify({ type: "message", message }),
        now + index + 1,
      );
    });
  } finally {
    db.close();
  }
}

function transcriptToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args, input: args }],
  };
}

function transcriptToolResult(id: string, name: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    isError,
    content: [{ type: "toolResult", id, name, content: "ok" }],
  };
}

function createCodexNpmPluginLiveFixture(root: string, storedSessionId?: string) {
  const stateDir = path.join(root, "state");
  const sessionKey = "agent:main:codex-npm-plugin-live";
  const sessionId = "codex-npm-plugin-live";
  const marker = "OPENCLAW-CODEX-NPM-PLUGIN-LIVE-OK";
  const threadId = "thread-codex-npm-live";
  const modelRef = "openai/gpt-5.4";
  writeJson("/tmp/openclaw-codex-agent.json", {
    payloads: [{ text: marker }],
    meta: { executionTrace: { winnerProvider: "openai" } },
  });
  writeSessionStoreSqlite({
    stateDir,
    sessionId,
    sessionKey,
  });
  writeJson(path.join(stateDir, "agents", "main", "codex-home", "sessions", "native.jsonl"), {
    threadId,
    marker,
  });
  writeCodexBindingStateSqlite({
    stateDir,
    sessionKey,
    sessionId,
    storedSessionId,
    threadId,
  });
  return { root, marker, sessionId, modelRef };
}

function createCodexNpmPluginLiveFollowthroughFixture(params: {
  root: string;
  messageFinals?: Array<boolean | undefined>;
  readFails?: boolean;
  workPlacement?:
    | "between"
    | "before-progress"
    | "before-progress-result"
    | "write-result-after-completion";
}) {
  const fixture = createCodexNpmPluginLiveFixture(params.root);
  const progressMarker = `${fixture.marker}-FOLLOWTHROUGH-PROGRESS`;
  const completeMarker = `${fixture.marker}-FOLLOWTHROUGH-COMPLETE`;
  const workspaceDir = path.join(params.root, "state", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const inputPaths = ["ALPHA.md", "BETA.md", "GAMMA.md"].map((name, index) => {
    const inputPath = path.join(workspaceDir, name);
    writeFileSync(inputPath, `hidden-${index + 1}\n`, "utf8");
    return inputPath;
  });
  const artifactPath = path.join(workspaceDir, "codex-progress-followthrough.txt");
  writeFileSync(artifactPath, "hidden-1\nhidden-2\nhidden-3\n", "utf8");
  writeJson("/tmp/openclaw-codex-followthrough.json", {
    payloads: [progressMarker, completeMarker].map((text) => ({ text })),
    meta: { executionTrace: { winnerProvider: "openai" } },
  });
  const messageFinals = params.messageFinals ?? [undefined, true];
  const messageCalls = [progressMarker, completeMarker].map((text, index) => {
    const args = {
      action: "send",
      message: text,
      ...(messageFinals[index] === undefined ? {} : { final: messageFinals[index] }),
    };
    const id = `message-${index + 1}`;
    return [transcriptToolCall(id, "message", args), transcriptToolResult(id, "message")];
  });
  const [progressCalls, completionCalls] = messageCalls;
  if (!progressCalls || !completionCalls) {
    throw new Error("expected progress and completion message fixtures");
  }
  const readId = "workspace-read";
  const readMessages = [
    transcriptToolCall(readId, "bash", {
      command: "cat *.md",
    }),
    transcriptToolResult(readId, "bash", params.readFails),
  ];
  const writeId = "workspace-write";
  const writeMessages = [
    transcriptToolCall(writeId, "bash", {
      command: "cat *.md > codex-progress-followthrough.txt",
    }),
    transcriptToolResult(writeId, "bash"),
  ];
  const workMessages = [...readMessages, ...writeMessages];
  let transcriptMessages;
  if (params.workPlacement === "before-progress") {
    transcriptMessages = [...workMessages, ...progressCalls, ...completionCalls];
  } else if (params.workPlacement === "before-progress-result") {
    transcriptMessages = [progressCalls[0], ...workMessages, progressCalls[1], ...completionCalls];
  } else if (params.workPlacement === "write-result-after-completion") {
    transcriptMessages = [
      ...progressCalls,
      ...readMessages,
      ...writeMessages.slice(0, 1),
      ...completionCalls,
      ...writeMessages.slice(1),
    ];
  } else {
    transcriptMessages = [...progressCalls, ...workMessages, ...completionCalls];
  }
  replaceSessionTranscriptMessages({
    stateDir: path.join(params.root, "state"),
    sessionId: fixture.sessionId,
    messages: transcriptMessages,
  });
  return {
    ...fixture,
    progressMarker,
    completeMarker,
    artifactPath,
    inputPaths,
  };
}

function createLegacyCodexNpmPluginLiveFixture(root: string) {
  const fixture = createCodexNpmPluginLiveFixture(root);
  const stateDir = path.join(fixture.root, "state");
  rmSync(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"));
  const sessionFile = path.join(stateDir, "agents", "main", "sessions", "session.jsonl");
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, '{"type":"message"}\n', "utf8");
  rmSync(path.join(stateDir, "state", "openclaw.sqlite"));
  writeJson(`${sessionFile}.codex-app-server.json`, {
    schemaVersion: 2,
    threadId: "thread-codex-npm-live",
    cwd: stateDir,
    model: "gpt-5.4",
    modelProvider: "codex",
  });
  writeJson(path.join(stateDir, "agents", "main", "sessions", "sessions.json"), {
    "agent:main:codex-npm-plugin-live": {
      sessionId: fixture.sessionId,
      agentHarnessId: "codex",
      sessionFile,
    },
  });
  return {
    ...fixture,
    bindingStoreContract: "legacy-sidecar" as const,
    sessionStoreContract: "legacy-json" as const,
  };
}

function currentCodexPlatformTarget() {
  const platformTargets: Record<string, { alias: string; os: string; cpu: string }> = {
    "linux:x64": { alias: "@openai/codex-linux-x64", os: "linux", cpu: "x64" },
    "linux:arm64": { alias: "@openai/codex-linux-arm64", os: "linux", cpu: "arm64" },
    "darwin:x64": { alias: "@openai/codex-darwin-x64", os: "darwin", cpu: "x64" },
    "darwin:arm64": { alias: "@openai/codex-darwin-arm64", os: "darwin", cpu: "arm64" },
    "win32:x64": { alias: "@openai/codex-win32-x64", os: "win32", cpu: "x64" },
    "win32:arm64": { alias: "@openai/codex-win32-arm64", os: "win32", cpu: "arm64" },
  };
  const target = platformTargets[`${process.platform}:${process.arch}`];
  if (!target) {
    throw new Error(`unsupported Codex test platform: ${process.platform}/${process.arch}`);
  }
  return target;
}

function createCodexInstallFixture(root: string) {
  writeJson("/tmp/openclaw-candidate-codex-package.json", {
    dependencies: { "@openai/codex": CODEX_VERSION },
  });
  const stateDir = path.join(root, "state");
  const npmRoot = path.join(stateDir, "npm");
  const installPath = path.join(npmRoot, "projects", "codex", "node_modules", "@openclaw", "codex");
  const projectRoot = npmProjectRootForInstalledPackage(installPath, "@openclaw/codex");
  const target = currentCodexPlatformTarget();
  const pluginPackageJson = path.join(installPath, "package.json");
  writeJson(pluginPackageJson, {
    name: "@openclaw/codex",
    dependencies: { "@openai/codex": CODEX_VERSION },
    openclaw: { install: { requiredPlatformPackages: [target.alias] } },
  });
  const openAiCodexRoot = path.join(projectRoot, "node_modules", "@openai", "codex");
  const openAiCodexPackageJson = path.join(openAiCodexRoot, "package.json");
  writeJson(openAiCodexPackageJson, {
    name: "@openai/codex",
    version: CODEX_VERSION,
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      [target.alias]: `npm:@openai/codex@${CODEX_VERSION}-${process.platform}-${process.arch}`,
    },
  });
  const codexBin = path.join(openAiCodexRoot, "bin", "codex.js");
  mkdirSync(path.dirname(codexBin), { recursive: true });
  writeFileSync(codexBin, `#!/usr/bin/env node\nconsole.log("codex-cli ${CODEX_VERSION}");\n`, {
    mode: 0o755,
  });
  chmodSync(codexBin, 0o755);
  const platformPackageJson = path.join(
    projectRoot,
    "node_modules",
    ...target.alias.split("/"),
    "package.json",
  );
  writeJson(platformPackageJson, {
    name: "@openai/codex",
    version: `${CODEX_VERSION}-${process.platform}-${process.arch}`,
    os: [target.os],
    cpu: [target.cpu],
  });
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: { defaults: { model: { primary: "openai/gpt-6-astra" } } },
    models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
  });
  writePluginInstallIndexForE2E(
    {
      installRecords: {
        codex: {
          installPath,
          source: "npm",
          spec: "npm:@openclaw/codex",
        },
      },
    },
    { stateDir },
  );
  writeJson("/tmp/openclaw-onboard.json", {
    ok: true,
    mode: "local",
    authChoice: "openai-api-key",
  });
  writeJson("/tmp/openclaw-codex-inspect.json", {
    plugin: { id: "codex", status: "loaded", agentHarnessIds: ["codex"] },
  });
  writeJson("/tmp/openclaw-plugins-list.json", {
    plugins: [{ id: "codex", enabled: true, status: "loaded" }],
  });
  writeAuthProfileStoreSqlite(stateDir);
  return {
    pluginPackageJson,
  };
}

describe("Codex install helpers", () => {
  it("resolves package roots and package manifests inside managed npm installs", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-install-utils-");
    const packageRoot = path.join(
      root,
      "state",
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const projectRoot = npmProjectRootForInstalledPackage(packageRoot, "@openclaw/codex");
    const dependencyPackage = path.join(
      projectRoot,
      "node_modules",
      "@openai",
      "codex",
      "package.json",
    );
    writeJson(dependencyPackage, { name: "@openai/codex" });

    expect(projectRoot).toBe(path.join(root, "state", "npm", "projects", "codex"));
    expect(findPackageJson("@openai/codex", [packageRoot, projectRoot])).toBe(dependencyPackage);
    expect(() =>
      assertPathInside(projectRoot, dependencyPackage, "codex dependency"),
    ).not.toThrow();
    expect(() => assertPathInside(projectRoot, os.tmpdir(), "outside path")).toThrow(
      "outside path resolved outside",
    );
  });

  it("accepts a complete on-demand Codex npm install fixture", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-on-demand-");
    createCodexInstallFixture(root);
    const agentDatabasePath = path.join(
      root,
      "state",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    mkdirSync(path.dirname(agentDatabasePath), { recursive: true });
    const agentDatabase = new DatabaseSync(agentDatabasePath);
    try {
      agentDatabase.exec("CREATE TABLE unrelated_state (key TEXT PRIMARY KEY)");
    } finally {
      agentDatabase.close();
    }

    const result = runCodexOnDemandAssertions(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`[codex-release] packageVersion=${CODEX_VERSION}`);
    expect(result.stdout).toContain(`[codex-release] cliVersion=${CODEX_VERSION}`);
    expect(result.stdout).toContain(
      `[codex-release] platformAlias=${currentCodexPlatformTarget().alias}`,
    );
    expect(result.stdout).toContain(
      `[codex-release] platformVersion=${CODEX_VERSION}-${process.platform}-${process.arch}`,
    );
    expect(result.stdout).toContain(`[codex-release] platformOs=${process.platform}`);
    expect(result.stdout).toContain(`[codex-release] platformCpu=${process.arch}`);
  });

  it("rejects plugin pins that differ from the candidate", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-candidate-pin-");
    const fixture = createCodexInstallFixture(root);
    const pluginPackage = JSON.parse(readFileSync(fixture.pluginPackageJson, "utf8"));
    pluginPackage.dependencies["@openai/codex"] = "0.153.0";
    writeJson(fixture.pluginPackageJson, pluginPackage);

    const result = runCodexOnDemandAssertions(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `@openclaw/codex must depend on @openai/codex ${CODEX_VERSION}; found 0.153.0`,
    );
  });

  it("accepts settled failed work before a later successful artifact write", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-recovered-work-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({ root, readFails: true });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects workspace work outside the progress and completion messages", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-work-order-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      workPlacement: "before-progress",
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "expected progress to be the first completed tool call in its turn",
    );
  });

  it("rejects workspace work issued before progress delivery completes", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-batched-work-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      workPlacement: "before-progress-result",
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "expected progress to be the first completed tool call in its turn",
    );
  });

  it("rejects completion sent before the artifact write succeeds", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-pending-write-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      workPlacement: "write-result-after-completion",
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected all workspace work to settle before completion");
  });

  it("accepts a terminal completion message without the optional final marker", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-legacy-completion-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      messageFinals: [undefined, undefined],
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts explicit progress and completion final controls", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-followthrough-explicit-finals-");
    const fixture = createCodexNpmPluginLiveFollowthroughFixture({
      root,
      messageFinals: [false, true],
    });

    const result = runCodexNpmPluginLiveFollowthroughAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts the explicit frozen-target JSON session and sidecar binding contract", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-legacy-");
    const fixture = createLegacyCodexNpmPluginLiveFixture(root);

    const result = runCodexNpmPluginLiveAssertions(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects a Codex binding owned by a stale physical session generation", () => {
    const root = makeTempDir(tempDirs, "openclaw-codex-npm-live-stale-");
    const fixture = createCodexNpmPluginLiveFixture(root, "previous-session");

    const result = runCodexNpmPluginLiveAssertions(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "belongs to session previous-session, expected codex-npm-plugin-live",
    );
  });
});
