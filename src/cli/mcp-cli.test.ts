import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastErrorLine,
  lastLogLine,
  mockError,
  mockLog,
  readMcpOAuthCredentialsStatus,
  resetMcpCliTestState,
  runMcpCommand,
  setCreateSessionMcpRuntimeOverride,
  serveOpenClawChannelMcp,
} from "./mcp-cli.test-harness.js";
import { writeProbeMcpServer } from "./mcp-cli.test-support.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";

const mcp = (...args: string[]) => runMcpCommand(["mcp", ...args]);
const flags = (options: Record<string, string | true>) =>
  Object.entries(options).flatMap(([key, value]) => (value === true ? [key] : [key, value]));

async function expectFailure(message: string, ...args: string[]) {
  await expect(mcp(...args)).rejects.toMatchObject({ code: 1 });
  expect(lastErrorLine()).toBe(message);
}
const setServer = (
  server: object | string = { command: "node", args: ["server.mjs"] },
  name = "docs",
) => mcp("set", name, typeof server === "string" ? server : JSON.stringify(server));

async function readJson(...args: string[]) {
  mockLog.mockClear();
  await mcp(...args, "--json");
  return JSON.parse(lastLogLine());
}
const readServer = (name = "docs") => readJson("show", name);
const logOutput = () => mockLog.mock.calls.map(([line]) => String(line)).join("\n");
type Catalog = Awaited<ReturnType<SessionMcpRuntime["getCatalog"]>>;
const catalog = (servers: Catalog["servers"], tools: Catalog["tools"] = []): Catalog => ({
  version: 1,
  generatedAt: Date.now(),
  servers,
  tools,
  diagnostics: [],
});
const finalizedProbe = () =>
  runCliWithExitFinalization({
    run: () => mcp("probe", "--json"),
    onError: (error) => {
      throw error;
    },
  });

async function writeExecutable(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", "utf-8");
  await fs.chmod(file, 0o755);
}

function expectDoctor(issues: unknown = [], ok = true) {
  expect(JSON.parse(lastLogLine())).toMatchObject({ ok, servers: [{ name: "docs", ok, issues }] });
}

function missingExecutable(command: string, name = "docs") {
  return {
    name,
    ok: false,
    issues: [{ level: "error", message: `stdio command not found or not executable: ${command}` }],
  };
}

function probeRuntime(
  params: Pick<SessionMcpRuntime, "sessionId" | "workspaceDir">,
  configFingerprint: string,
  getCatalog: SessionMcpRuntime["getCatalog"],
): SessionMcpRuntime {
  return {
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    configFingerprint,
    createdAt: 0,
    lastUsedAt: 0,
    getCatalog,
    peekCatalog: () => null,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
  };
}

const literalWarning = (field: string, level?: "warning") =>
  expect.objectContaining({
    ...(level ? { level } : {}),
    message: expect.stringContaining(`${field} contains a literal sensitive value`),
  });
const httpServer = (url = "https://mcp.example.com") => ({
  url,
  transport: "streamable-http",
  auth: "oauth",
});

async function writeMcpServers(servers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(configPath, `${JSON.stringify({ mcp: { servers } })}\n`, "utf8");
}

let home: string;
let workspaceDir: string;
let configPath: string;

let restoreHome: () => Promise<void>;

beforeEach(async () => {
  resetMcpCliTestState();
  const env = await createTempHomeEnv("openclaw-cli-mcp-home-");
  restoreHome = env.restore;
  home = env.home;
  workspaceDir = await createWorkspace();
  configPath = path.join(home, ".openclaw", "openclaw.json");
  vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
});

afterEach(async () => {
  try {
    await restoreHome();
  } finally {
    vi.unstubAllEnvs();
    await cleanupMcpCliTestState();
  }
});

it("escapes MCP report fields without altering JSON or the saved server", async () => {
  const name = "café\x1b[31m\nforged\tserver\r\x00\x85end";
  const servers = {
    [name]: { command: "node", args: ["café\x1b[31m\nforged-arg"], enabled: false },
    normal: { command: "node", enabled: false },
  };
  await writeMcpServers(servers);
  const before = await fs.readFile(configPath, "utf8");
  for (const args of [["list"], ["show", name], ["status", "--verbose"], ["doctor"]]) {
    mockLog.mockClear();
    await mcp(...args);
    const report = args[0] === "show" ? String(mockLog.mock.calls[0]?.[0]) : logOutput();
    expect(report).toContain("café\\nforged\\tserver\\rend");
    expect(report.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  }
  expect(await readJson("list")).toEqual(servers);
  expect(await fs.readFile(configPath, "utf8")).toBe(before);
});

it("escapes mutation acknowledgements and unknown-server errors without rewriting names", async () => {
  const name = "café\x1b[31m\nforged";
  await setServer({ command: "node", enabled: false }, name);
  expect(lastLogLine()).toContain('Saved MCP server "café\\nforged"');
  expect(await readJson("list")).toHaveProperty(name);
  mockError.mockClear();
  await expect(mcp("show", `${name}-missing`)).rejects.toMatchObject({ code: 1 });
  expect(lastErrorLine()).toContain('No MCP server named "café\\nforged-missing"');
  expect(lastErrorLine()).not.toMatch(/\p{Cc}/u);
});

it("adds a configured MCP server from flags without replacing operator knobs", async () => {
  await mcp(
    "add",
    "docs",
    ...flags({
      "--url": "https://mcp.example.com/mcp",
      "--transport": "streamable-http",
      "--header": "Authorization=Bearer token",
      "--auth": "oauth",
      "--oauth-scope": "docs.read",
      "--include": "search,read_*",
      "--timeout": "12",
      "--connect-timeout": "3",
      "--parallel": true,
      "--approval": "approve",
      "--no-probe": true,
    }),
  );

  expect(await readServer()).toEqual({
    url: "https://mcp.example.com/mcp",
    transport: "streamable-http",
    headers: { Authorization: REDACTED_SENTINEL },
    auth: "oauth",
    oauth: { scope: "docs.read" },
    toolFilter: { include: ["search", "read_*"] },
    requestTimeoutMs: 12_000,
    connectionTimeoutMs: 3_000,
    supportsParallelToolCalls: true,
    codex: { defaultToolsApprovalMode: "approve" },
  });
  expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers.docs.headers).toEqual({
    Authorization: "Bearer token",
  });
});

it("redacts MCP registry inspection without changing saved credentials", async () => {
  vi.stubEnv("MCP_DISPLAY_TOKEN", "example-resolved-token-not-real");
  vi.stubEnv("MCP_DISPLAY_HEADER", "example-header-token-not-real");
  const servers = {
    remote: {
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: "Bearer ${MCP_DISPLAY_HEADER}",
        "X-Goog-Api-Key": "example-maps-key-not-real",
        "X-Custom-Credential": "example-custom-header-not-real",
      },
    },
    local: {
      command: "node",
      args: ["server.mjs", "--api-key", "example-argv-key-not-real", "--region", "us-east-1"],
      env: {
        SERVICE_TOKEN: "example-env-token-not-real",
        REFERENCE: "${MCP_DISPLAY_TOKEN}",
      },
    },
  };
  await writeMcpServers(servers);

  for (const args of [
    ["list", "--json"],
    ["show", "--json"],
    ["show", "remote", "--json"],
    ["show", "local", "--json"],
    ["show"],
    ["show", "remote"],
    ["show", "local"],
  ]) {
    mockLog.mockClear();
    await mcp(...args);
    const output = logOutput();
    for (const secret of [
      "example-header-token-not-real",
      "example-maps-key-not-real",
      "example-custom-header-not-real",
      "example-argv-key-not-real",
      "example-env-token-not-real",
      "example-resolved-token-not-real",
    ]) {
      expect(output, args.join(" ")).not.toContain(secret);
    }
    const inspected = JSON.parse(lastLogLine());
    if (args[1] !== "remote" && args[1] !== "local") {
      expect(inspected.remote.url).toBe("https://mcp.example.com/mcp");
      expect(inspected.local.args).toContain("us-east-1");
      expect(inspected.local.env.REFERENCE).toBe(REDACTED_SENTINEL);
    }
  }

  expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers).toEqual(servers);
  await setServer(await readServer("remote"), "remote");
  await setServer(await readServer("local"), "local");
  expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers).toEqual(servers);
});

it.each(["node", " node "])("preserves literal stdio paths from add flags: %j", async (name) => {
  const command = path.join(workspaceDir, name);
  const cwd = path.join(workspaceDir, `${name}-workspace `);
  await mcp(
    "add",
    "literal",
    "--command",
    command,
    "--arg",
    "server.mjs",
    "--cwd",
    cwd,
    "--no-probe",
  );
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  expect(saved.mcp.servers.literal).toEqual({ command, args: ["server.mjs"], cwd });
  expect(await readServer("literal")).toEqual({ command, args: ["server.mjs"], cwd });
});

it.each([
  { mode: "existing", script: "existing.mjs" },
  { mode: "race", script: "winner.mjs" },
] as const)("preserves the $mode MCP server when add loses", async ({ mode, script }) => {
  if (mode === "existing") {
    await setServer({ command: "node", args: [script] });
  }
  let competitorWon = false;
  const probe = vi.fn<Parameters<typeof setCreateSessionMcpRuntimeOverride>[0]>((params) => {
    if (mode === "existing") {
      throw new Error("duplicate add attempted a probe");
    }
    expect(params.cfg?.mcp?.servers?.docs?.connectionTimeoutMs).toBe(5_000);
    return probeRuntime(params, "cli-probe-race", async () => {
      competitorWon = (
        await setConfiguredMcpServer({
          name: "docs",
          server: { command: "node", args: [script] },
          createOnly: true,
        })
      ).ok;
      return catalog({
        docs: { serverName: "docs", launchSummary: "node winner.mjs", toolCount: 0 },
      });
    });
  });
  setCreateSessionMcpRuntimeOverride(probe);
  await expectFailure('MCP server "docs" already exists.', "add", "docs", "--command", "uvx");
  expect(probe).toHaveBeenCalledTimes(mode === "existing" ? 0 : 1);
  if (mode === "race") {
    expect(competitorWon).toBe(true);
  }
  expect(await readServer()).toEqual({ command: "node", args: [script] });
});

it("configures approval and exclusions without replacing sibling metadata", async () => {
  await setServer({
    command: process.execPath,
    codex: { agents: ["docs-agent"], defaultToolsApprovalMode: "auto" },
    toolFilter: { include: ["old_*"], exclude: ["admin_*"] },
  });
  await mcp("configure", "docs", "--approval", "approve", "--exclude", "write_*");
  expect(await readServer()).toEqual({
    command: process.execPath,
    codex: { agents: ["docs-agent"], defaultToolsApprovalMode: "approve" },
    toolFilter: { include: ["old_*"], exclude: ["write_*"] },
  });
});

it("rejects hexadecimal MCP timeout options before writing configuration", async () => {
  await expect(
    mcp("add", "docs", "--url", "https://mcp.example.com/mcp", "--timeout", "0x10", "--no-probe"),
  ).rejects.toMatchObject({ code: 1 });
  expect(lastErrorLine()).toBe("--timeout must be a positive number.");
  await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  await setServer('{"url":"https://mcp.example.com","requestTimeoutMs":12000}');
  mockError.mockClear();

  await expectFailure(
    "--connect-timeout must be a positive number.",
    "configure",
    "docs",
    "--connect-timeout",
    "0x3",
  );

  expect(await readServer()).toEqual({
    url: "https://mcp.example.com",
    requestTimeoutMs: 12_000,
  });
});

it(
  "requires initialize to finish within the configured probe timeout before saving",
  { timeout: 10_000 },
  async () => {
    const serverPath = path.join(workspaceDir, "probe-server.mjs");

    await writeProbeMcpServer(serverPath);
    const addProbe = (name: string, mode: string, extra: string[] = []) =>
      mcp(
        "add",
        name,
        "--command",
        process.execPath,
        "--arg",
        serverPath,
        "--env",
        `MCP_MODE=${mode}`,
        ...extra,
      );

    const startedAt = performance.now();
    await expect(
      addProbe("hung", "hang-start", ["--connect-timeout", "0.2"]),
    ).rejects.toMatchObject({ code: 1 });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(lastErrorLine()).toContain(
      'MCP server "hung" timed out: did not complete initialize within 0.2s',
    );
    await expect(fs.readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await addProbe("ok", "normal");
    expect(lastLogLine()).toBe(`Saved MCP server "ok" to ${configPath}.`);

    await expect(addProbe("crash", "crash")).rejects.toMatchObject({ code: 1 });

    const saved: Record<string, unknown> = await readJson("list");
    expect(Object.keys(saved)).toEqual(["ok"]);
  },
);

it("explains only disabled servers and overrides while preserving JSON output", async () => {
  await writeMcpServers({
    paused: { enabled: false, command: process.execPath },
    override: { enabled: false },
  });

  await mcp("probe");

  const output = logOutput();
  expect(output).toContain("No enabled MCP servers in");
  expect(output).toContain("openclaw mcp add <name> --command <command>");
  expect(output).toContain("openclaw mcp configure <name> --enable");
  expect(output).not.toMatch(/^MCP check \(.*\):$/m);

  mockLog.mockClear();
  await mcp("probe", "--json");
  expect(mockLog).toHaveBeenCalledTimes(1);
  expect(JSON.parse(lastLogLine())).toEqual({
    generatedAt: expect.any(String),
    servers: {},
    tools: [],
    diagnostics: [],
  });
});

it("requires an explicit MCP tool filter operation", async () => {
  await setServer();
  await expectFailure("Specify --include, --exclude, or --clear.", "tools", "docs");
});

it.each([
  ["tools", "--clear"],
  ["configure", "--clear-tools"],
])("clears per-server MCP tool filters with %s %s", async (command, clearFlag) => {
  await setServer();
  await mcp("tools", "docs", "--include", "search");
  await mcp(command, "docs", clearFlag);

  expect(await readServer()).not.toHaveProperty("toolFilter");
});

it("redacts stdio argv credentials from MCP status output", async () => {
  await setServer(
    '{"command":"node","args":["server.mjs","--api-key","test-api-key","--token=test-token"]}',
    "local",
  );
  mockLog.mockClear();

  await mcp("status", "--json");
  const jsonOutput = lastLogLine();
  expect(jsonOutput).not.toContain("test-api-key");
  expect(jsonOutput).not.toContain("test-token");
  expect(JSON.parse(jsonOutput).servers[0].launch).toBe(
    "node server.mjs --api-key *** --token=***",
  );

  mockLog.mockClear();
  await mcp("status", "--verbose");
  const verboseOutput = logOutput();
  expect(verboseOutput).toContain("launch: node server.mjs --api-key *** --token=***");
  expect(verboseOutput).not.toContain("test-api-key");
  expect(verboseOutput).not.toContain("test-token");
});

it("reports MCP doctor setup errors and sensitive literals", async () => {
  vi.stubEnv("MCP_DOCTOR_AUTHORED_TOKEN", "test-token");
  await setServer({
    command: "./missing-mcp",
    env: { DOCS_API_KEY: "literal" },
    headers: {
      Authorization: "Bearer literal",
      "X-API-Key": "${MCP_DOCTOR_AUTHORED_TOKEN:-literal-fallback}",
      "Proxy-Authorization": "$${MCP_DOCTOR_AUTHORED_TOKEN} ${MCP_DOCTOR_AUTHORED_TOKEN}",
      "Api-Key": "Basic ${MCP_DOCTOR_AUTHORED_TOKEN}:literal-password",
    },
  });
  mockLog.mockClear();

  await expectFailure("MCP doctor found errors.", "doctor", "--json");
  expectDoctor(
    expect.arrayContaining([
      expect.objectContaining({
        level: "error",
        message: "stdio command not found or not executable: ./missing-mcp",
      }),
      literalWarning("env.DOCS_API_KEY", "warning"),
      literalWarning("headers.Authorization", "warning"),
      literalWarning("headers.X-API-Key"),
      literalWarning("headers.Proxy-Authorization"),
      literalWarning("headers.Api-Key"),
    ]),
    false,
  );
});

it("does not flag authored MCP header/env references after environment resolution", async () => {
  vi.stubEnv("MCP_DOCTOR_AUTHORED_TOKEN", "Bearer test-token");
  const stateDir = path.join(home, ".openclaw");
  await fs.writeFile(
    path.join(stateDir, "mcp-servers.json"),
    JSON.stringify({
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: {
          Authorization: "${MCP_DOCTOR_AUTHORED_TOKEN}",
          "Proxy-Authorization": "Bearer ${MCP_DOCTOR_AUTHORED_TOKEN}",
          "X-API-Key": "${MCP_DOCTOR_AUTHORED_TOKEN:-}",
          api_key: "${MCP_DOCTOR_AUTHORED_TOKEN}${MCP_DOCTOR_AUTHORED_TOKEN}",
        },
        env: { DOCS_API_KEY: "${MCP_DOCTOR_AUTHORED_TOKEN}" },
      },
    }),
  );
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ mcp: { servers: { $include: "./mcp-servers.json" } } }),
  );

  await mcp("doctor", "docs", "--json");

  expectDoctor();
});

it("reports ignored OAuth Authorization headers regardless of casing", async () => {
  readMcpOAuthCredentialsStatus.mockResolvedValue({ state: "authorized" });
  const cases = [
    ["lowercase", "authorization", true, true],
    ["titlecase", "Authorization", true, true],
    ["uppercase", "AUTHORIZATION", true, true],
    ["proxy", "Proxy-Authorization", true, false],
    ["unrelated", "X-Tenant", true, false],
    ["without-oauth", "AUTHORIZATION", false, false],
  ] as const;
  await writeMcpServers(
    Object.fromEntries(
      cases.map(([name, header, oauth]) => [
        name,
        {
          url: "https://mcp.example.com/mcp",
          headers: { [header]: "$MCP_HEADER" },
          ...(oauth ? { auth: "oauth" } : {}),
        },
      ]),
    ),
  );
  const { servers } = await readJson("doctor");
  expect(
    Object.fromEntries(
      servers.map(({ name, issues }: { name: string; issues: Array<{ message: string }> }) => [
        name,
        issues.some(
          ({ message }) =>
            message === "OAuth is enabled and the static Authorization header is ignored",
        ),
      ]),
    ),
  ).toEqual(Object.fromEntries(cases.map((entry) => [entry[0], entry[3]])));
});

it("bounds concurrent MCP doctor server checks", async () => {
  await writeMcpServers(
    Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `server-${index}`,
        httpServer(`https://mcp-${index}.example.com`),
      ]),
    ),
  );

  const checksBlocked = createDeferred();
  const firstBatchStarted = createDeferred();
  let startedChecks = 0;
  readMcpOAuthCredentialsStatus.mockImplementation(async () => {
    startedChecks += 1;
    if (startedChecks === 4) {
      firstBatchStarted.resolve();
    }
    await checksBlocked.promise;
    return {
      state: "unauthenticated",
    };
  });

  const doctorPromise = mcp("doctor", "--json");
  try {
    await Promise.race([firstBatchStarted.promise, doctorPromise]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(startedChecks).toBe(4);
  } finally {
    checksBlocked.resolve();
    await doctorPromise;
  }

  expect(readMcpOAuthCredentialsStatus).toHaveBeenCalledTimes(6);
  expect(JSON.parse(lastLogLine()).servers.map((server: { name: string }) => server.name)).toEqual([
    "server-0",
    "server-1",
    "server-2",
    "server-3",
    "server-4",
    "server-5",
  ]);
});

it("surfaces unexpected MCP doctor check errors", async () => {
  await setServer(httpServer());
  readMcpOAuthCredentialsStatus.mockRejectedValueOnce(new Error("credential store failed"));

  await expect(mcp("doctor", "--json")).rejects.toThrow("credential store failed");
});

it("does not fail MCP doctor for disabled-only overrides", async () => {
  await setServer(
    '{"enabled":false,"env":{"DOCS_API_KEY":"literal"},"headers":{"Authorization":"Bearer literal"}}',
  );
  await readJson("doctor");
  expectDoctor(
    expect.arrayContaining([
      { level: "warning", message: "server is disabled" },
      literalWarning("env.DOCS_API_KEY", "warning"),
      literalWarning("headers.Authorization", "warning"),
    ]),
  );
});

it.runIf(process.platform !== "win32")(
  "does not treat Path as PATH when checking MCP stdio commands",
  async () => {
    const binDir = path.join(workspaceDir, "bin");
    const commandPath = path.join(binDir, "mis-cased-path-mcp");
    await writeExecutable(commandPath);

    await setServer({ command: "mis-cased-path-mcp", env: { Path: binDir } });
    mockLog.mockClear();

    await expect(mcp("doctor", "--json")).rejects.toMatchObject({ code: 1 });

    expectDoctor(missingExecutable("mis-cased-path-mcp").issues, false);
  },
);

it("resolves relative configured PATH entries from the MCP stdio cwd", async () => {
  const appDir = path.join(workspaceDir, "app");
  const binDir = path.join(appDir, "node_modules", ".bin");
  const commandPath = path.join(binDir, "docs-mcp");
  await writeExecutable(commandPath);

  await setServer({
    command: "docs-mcp",
    cwd: appDir,
    env: { PATH: "node_modules/.bin" },
  });
  mockLog.mockClear();

  await mcp("doctor", "--json");

  expectDoctor();
});

it("removes pure disabled tombstones when enabling MCP servers", async () => {
  await setServer('{"enabled":false}', "bundleProbe");
  await mcp("configure", "bundleProbe", "--enable");

  mockLog.mockClear();
  await mcp("list");
  const output = logOutput();
  expect(output).toContain("No OpenClaw-managed MCP servers configured in ");
  expect(output).toContain("does not include mcporter servers from config/mcporter.json");
});

it("fails named probes for disabled MCP servers", async () => {
  await setServer('{"enabled":false}');

  await expectFailure(
    `MCP server "docs" is disabled in ${configPath}. Run openclaw mcp configure docs --enable before checking it.`,
    "probe",
    "docs",
  );
});

it("reports omitted enabled servers while accepting omitted disabled servers", async () => {
  const invocationExitCode = process.exitCode;

  let catalogServers: Record<
    string,
    { serverName: string; launchSummary: string; toolCount: number }
  > = {};
  await writeMcpServers({ incomplete: { command: "node" } });
  setCreateSessionMcpRuntimeOverride((params) =>
    probeRuntime(params, "cli-probe-test", async () => catalog(catalogServers)),
  );

  mockError.mockClear();
  await finalizedProbe();

  expect(JSON.parse(lastLogLine())).toMatchObject({ servers: {}, diagnostics: [] });
  expect(lastErrorLine()).toBe(`MCP check did not connect to "incomplete" in ${configPath}.`);
  expect(process.exitCode).toBe(1);
  // The next probe represents a new CLI invocation, not a continuation of its failed status.
  process.exitCode = invocationExitCode;

  await writeMcpServers({
    healthy: { command: "node" },
    disabled: { enabled: false },
  });
  catalogServers = {
    healthy: { serverName: "healthy", launchSummary: "node", toolCount: 1 },
  };
  mockError.mockClear();
  mockLog.mockClear();

  await finalizedProbe();

  expect(JSON.parse(lastLogLine())).toMatchObject({
    servers: { healthy: { tools: 1 } },
    diagnostics: [],
  });
  expect(lastErrorLine()).toBe("");
  expect(process.exitCode).toBe(invocationExitCode);

  mockLog.mockClear();
  await mcp("probe");
  const output = logOutput();
  expect(output).toContain("- healthy: 1 tools");
  expect(output).not.toContain("No enabled MCP servers");
});

it("warns when auto-approved Codex MCP tools have no safety annotations", async () => {
  await setServer({ command: process.execPath }, "memory");
  setCreateSessionMcpRuntimeOverride((params) =>
    probeRuntime(params, "cli-probe-approval-hint", async () =>
      catalog(
        {
          memory: {
            serverName: "memory",
            launchSummary: process.execPath,
            toolCount: 1,
            codexApprovalMode: "auto",
          },
        },
        [
          {
            serverName: "memory",
            safeServerName: "memory",
            toolName: "create_entities",
            inputSchema: { type: "object" },
            fallbackDescription: "Create entities",
            codexAnnotations: {},
          },
        ],
      ),
    ),
  );

  mockLog.mockClear();
  await mcp("probe", "memory");
  expect(logOutput()).toContain(
    "tools have no safety annotations; calls require approval in prompting session postures",
  );

  mockLog.mockClear();
  await mcp("doctor", "memory", "--probe");
  expect(logOutput()).toContain(
    "tools have no safety annotations; calls require approval in prompting session postures",
  );
});

it("fails when removing an unknown MCP server", async () => {
  await expectFailure(
    `No MCP server named "missing" in ${configPath}. Run openclaw mcp list to see configured servers.`,
    "unset",
    "missing",
  );
});

it("starts the channel bridge with parsed serve options", async () => {
  const tokenFile = path.join(workspaceDir, "gateway.token");
  await fs.writeFile(tokenFile, "secret-token\n", "utf-8");

  await mcp(
    "serve",
    "--url",
    "ws://127.0.0.1:18789",
    "--token-file",
    tokenFile,
    "--claude-channel-mode",
    "on",
    "--verbose",
  );

  expect(serveOpenClawChannelMcp).toHaveBeenCalledWith({
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: "secret-token",
    gatewayPassword: undefined,
    claudeChannelMode: "on",
    verbose: true,
  });
});

it("points serve startup failures at the deep Gateway health diagnostic", async () => {
  serveOpenClawChannelMcp.mockRejectedValueOnce(new Error("gateway unavailable"));

  await expectFailure(
    "MCP server failed to start: gateway unavailable. Run openclaw gateway status --deep --require-rpc to inspect Gateway health.",
    "serve",
  );
});
it("emits one JSON failure for an unknown server in show", async () => {
  await expect(mcp("show", "missing", "--json")).rejects.toMatchObject({
    code: 1,
  });

  expect(mockLog).toHaveBeenCalledTimes(1);
  expect(mockError).not.toHaveBeenCalled();
  expect(JSON.parse(lastLogLine())).toMatchObject({
    ok: false,
    error: {
      type: "cli_error",
      message: expect.stringContaining('No MCP server named "missing"'),
    },
  });
});

it("emits one JSON failure for invalid config in probe", async () => {
  await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), "{ invalid");
  await expect(mcp("probe", "--json")).rejects.toMatchObject({ code: 1 });

  expect(mockLog).toHaveBeenCalledTimes(1);
  expect(JSON.parse(lastLogLine())).toEqual({
    ok: false,
    error: {
      type: "cli_error",
      message: "Config file is invalid; fix it before using MCP config commands.",
    },
  });
});

it("reports directories and continues past them on PATH", async () => {
  const serverDir = path.join(workspaceDir, "docs-mcp-repo");
  const shadowDir = path.join(workspaceDir, "shadow");
  const binDir = path.join(workspaceDir, "bin");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.mkdir(path.join(shadowDir, "docs-mcp"), { recursive: true });
  await writeExecutable(path.join(binDir, "docs-mcp"));
  const servers = {
    "explicit-dir": { command: serverDir },
    "path-dir-only": { command: "docs-mcp", env: { PATH: shadowDir } },
    "path-dir-then-file": {
      command: "docs-mcp",
      env: { PATH: [shadowDir, binDir].join(path.delimiter) },
    },
  };
  for (const [name, server] of Object.entries(servers)) {
    await setServer(server, name);
  }
  mockLog.mockClear();

  await expect(mcp("doctor", "--json")).rejects.toMatchObject({ code: 1 });

  expect(JSON.parse(lastLogLine())).toMatchObject({
    ok: false,
    servers: [
      missingExecutable(serverDir, "explicit-dir"),
      missingExecutable("docs-mcp", "path-dir-only"),
      { name: "path-dir-then-file", ok: true, issues: [] },
    ],
  });
});
