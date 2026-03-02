import type { Mock } from "vitest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(() => {
  envSnapshot = captureEnv(["OPENCLAW_PROFILE"]);
  process.env.OPENCLAW_PROFILE = "isolated";
});

afterAll(() => {
  envSnapshot.restore();
});

function createDefaultSessionStoreEntry() {
  return {
    updatedAt: Date.now() - 60_000,
    verboseLevel: "on",
    thinkingLevel: "low",
    inputTokens: 2_000,
    outputTokens: 3_000,
    cacheRead: 2_000,
    cacheWrite: 1_000,
    totalTokens: 5_000,
    contextTokens: 10_000,
    model: "pi:opus",
    sessionId: "abc123",
    systemSent: true,
  };
}

function createUnknownUsageSessionStore() {
  return {
    "+1000": {
      updatedAt: Date.now() - 60_000,
      inputTokens: 2_000,
      outputTokens: 3_000,
      contextTokens: 10_000,
      model: "pi:opus",
    },
  };
}

function createChannelIssueCollector(channel: string) {
  return (accounts: Array<Record<string, unknown>>) =>
    accounts
      .filter((account) => typeof account.lastError === "string" && account.lastError)
      .map((account) => ({
        channel,
        accountId: typeof account.accountId === "string" ? account.accountId : "default",
        message: `Channel error: ${String(account.lastError)}`,
      }));
}

function createErrorChannelPlugin(params: { id: string; label: string; docsPath: string }) {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
      docsPath: params.docsPath,
      blurb: "mock",
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    status: {
      collectStatusIssues: createChannelIssueCollector(params.id),
    },
  };
}

async function withUnknownUsageStore(run: () => Promise<void>) {
  const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
  mocks.loadSessionStore.mockReturnValue(createUnknownUsageSessionStore());
  try {
    await run();
  } finally {
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  }
}

function getRuntimeLogs() {
  return runtimeLogMock.mock.calls.map((call: unknown[]) => String(call[0]));
}

function getJoinedRuntimeLogs() {
  return getRuntimeLogs().join("\n");
}

async function runStatusAndGetLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  runtimeLogMock.mockClear();
  await statusCommand(args, runtime as never);
  return getRuntimeLogs();
}

async function runStatusAndGetJoinedLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  await runStatusAndGetLogs(args);
  return getJoinedRuntimeLogs();
}

type ProbeGatewayResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: { code: number; reason: string } | null;
  health: unknown;
  status: unknown;
  presence: unknown;
  configSnapshot: unknown;
};

function mockProbeGatewayResult(overrides: Partial<ProbeGatewayResult>) {
  mocks.probeGateway.mockResolvedValueOnce({
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
    ...overrides,
  });
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const prevValue = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (prevValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prevValue;
    }
  }
}

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn().mockReturnValue({
    "+1000": createDefaultSessionStoreEntry(),
  }),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(5000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  logWebSelfId: vi.fn(),
  probeGateway: vi.fn().mockResolvedValue({
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  }),
  callGateway: vi.fn().mockResolvedValue({}),
  listAgentsForGateway: vi.fn().mockReturnValue({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Main" }],
  }),
  runSecurityAudit: vi.fn().mockResolvedValue({
    ts: 0,
    summary: { critical: 1, warn: 1, info: 2 },
    findings: [
      {
        checkId: "test.critical",
        severity: "critical",
        title: "Test critical finding",
        detail: "Something is very wrong\nbut on two lines",
        remediation: "Do the thing",
      },
      {
        checkId: "test.warn",
        severity: "warn",
        title: "Test warning finding",
        detail: "Something is maybe wrong",
      },
      {
        checkId: "test.info",
        severity: "info",
        title: "Test info finding",
        detail: "FYI only",
      },
      {
        checkId: "test.info2",
        severity: "info",
        title: "Another info finding",
        detail: "More FYI",
      },
    ],
  }),
}));

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: vi.fn(async ({ agentId }: { agentId: string }) => ({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => ({
        files: 2,
        chunks: 3,
        dirty: false,
        workspaceDir: "/tmp/openclaw",
        dbPath: "/tmp/memory.sqlite",
        provider: "openai",
        model: "text-embedding-3-small",
        requestedProvider: "openai",
        sources: ["memory"],
        sourceCounts: [{ source: "memory", files: 2, chunks: 3 }],
        cache: { enabled: true, entries: 10, maxEntries: 500 },
        fts: { enabled: true, available: true },
        vector: {
          enabled: true,
          available: true,
          extensionPath: "/opt/vec0.dylib",
          dims: 1024,
        },
      }),
      close: vi.fn(async () => {}),
      __agentId: agentId,
    })),
  },
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveMainSessionKey: mocks.resolveMainSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  resolveFreshSessionTotalTokens: vi.fn(
    (entry?: { totalTokens?: number; totalTokensFresh?: boolean }) =>
      typeof entry?.totalTokens === "number" && entry?.totalTokensFresh !== false
        ? entry.totalTokens
        : undefined,
  ),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () =>
    [
      {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/platforms/whatsapp",
          blurb: "mock",
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        status: {
          buildChannelSummary: async () => ({ linked: true, authAgeMs: 5000 }),
        },
      },
      {
        ...createErrorChannelPlugin({
          id: "signal",
          label: "Signal",
          docsPath: "/platforms/signal",
        }),
      },
      {
        ...createErrorChannelPlugin({
          id: "imessage",
          label: "iMessage",
          docsPath: "/platforms/mac",
        }),
      },
    ] as unknown,
}));
vi.mock("../web/session.js", () => ({
  webAuthExists: mocks.webAuthExists,
  getWebAuthAgeMs: mocks.getWebAuthAgeMs,
  readWebSelfId: mocks.readWebSelfId,
  logWebSelfId: mocks.logWebSelfId,
}));
vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: mocks.callGateway };
});
vi.mock("../gateway/session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
  return {
    ...actual,
    listAgentsForGateway: mocks.listAgentsForGateway,
  };
});
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn().mockResolvedValue("/tmp/openclaw"),
}));
vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: () => ({
    platform: "darwin",
    arch: "arm64",
    release: "23.0.0",
    label: "macos 14.0 (arm64)",
  }),
}));
vi.mock("../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn().mockResolvedValue({
    root: "/tmp/openclaw",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/tmp/openclaw",
      branch: "main",
      upstream: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 0,
      fetchOk: true,
    },
    deps: {
      manager: "pnpm",
      status: "ok",
      lockfilePath: "/tmp/openclaw/pnpm-lock.yaml",
      markerPath: "/tmp/openclaw/node_modules/.modules.yaml",
    },
    registry: { latestVersion: "0.0.0" },
  }),
  formatGitInstallLabel: vi.fn(() => "main · @ deadbeef"),
  compareSemverStrings: vi.fn(() => 0),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({ session: {} }),
  };
});
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 1234 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "gateway"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
    }),
  }),
}));
vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 4321 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "node-host"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
    }),
  }),
}));
vi.mock("../security/audit.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

import { statusCommand } from "./status.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const runtimeLogMock = runtime.log as Mock<(...args: unknown[]) => void>;

describe("statusCommand", () => {
  it("prints JSON when requested", async () => {
    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls[0]?.[0]));
    expect(payload.linkChannel.linked).toBe(true);
    expect(payload.memory.agentId).toBe("main");
    expect(payload.memoryPlugin.enabled).toBe(true);
    expect(payload.memoryPlugin.slot).toBe("memory-core");
    expect(payload.memory.vector.available).toBe(true);
    expect(payload.sessions.count).toBe(1);
    expect(payload.sessions.paths).toContain("/tmp/sessions.json");
    expect(payload.sessions.defaults.model).toBeTruthy();
    expect(payload.sessions.defaults.contextTokens).toBeGreaterThan(0);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].cacheRead).toBe(2_000);
    expect(payload.sessions.recent[0].cacheWrite).toBe(1_000);
    expect(payload.sessions.recent[0].totalTokensFresh).toBe(true);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
    expect(payload.sessions.recent[0].flags).toContain("verbose:on");
    expect(payload.securityAudit.summary.critical).toBe(1);
    expect(payload.securityAudit.summary.warn).toBe(1);
    expect(payload.gatewayService.label).toBe("LaunchAgent");
    expect(payload.nodeService.label).toBe("LaunchAgent");
  });

  it("surfaces unknown usage when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      runtimeLogMock.mockClear();
      await statusCommand({ json: true }, runtime as never);
      const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
      expect(payload.sessions.recent[0].totalTokens).toBeNull();
      expect(payload.sessions.recent[0].totalTokensFresh).toBe(false);
      expect(payload.sessions.recent[0].percentUsed).toBeNull();
      expect(payload.sessions.recent[0].remainingTokens).toBeNull();
    });
  });

  it("prints unknown usage in formatted output when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("unknown/") && line.includes("(?%)"))).toBe(true);
    });
  });

  it("prints formatted lines otherwise", async () => {
    const logs = await runStatusAndGetLogs();
    for (const token of [
      "OpenClaw status",
      "Overview",
      "Security audit",
      "Summary:",
      "CRITICAL",
      "Dashboard",
      "macos 14.0 (arm64)",
      "Memory",
      "Channels",
      "WhatsApp",
      "bootstrap files",
      "Sessions",
      "+1000",
      "50%",
      "40% cached",
      "LaunchAgent",
      "FAQ:",
      "Troubleshooting:",
      "Next steps:",
    ]) {
      expect(logs.some((line) => line.includes(token))).toBe(true);
    }
    expect(
      logs.some(
        (line) =>
          line.includes("openclaw status --all") ||
          line.includes("openclaw --profile isolated status --all"),
      ),
    ).toBe(true);
  });

  it("shows gateway auth when reachable", async () => {
    await withEnvVar("OPENCLAW_GATEWAY_TOKEN", "abcd1234", async () => {
      mockProbeGatewayResult({
        ok: true,
        connectLatencyMs: 123,
        error: null,
        health: {},
        status: {},
        presence: [],
      });
      const logs = await runStatusAndGetLogs();
      expect(logs.some((l: string) => l.includes("auth token"))).toBe(true);
    });
  });

  it("surfaces channel runtime errors from the gateway", async () => {
    mockProbeGatewayResult({
      ok: true,
      connectLatencyMs: 10,
      error: null,
      health: {},
      status: {},
      presence: [],
    });
    mocks.callGateway.mockResolvedValueOnce({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imessage permission denied",
          },
        ],
      },
    });

    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toMatch(/Signal/i);
    expect(joined).toMatch(/iMessage/i);
    expect(joined).toMatch(/gateway:/i);
    expect(joined).toMatch(/WARN/);
  });

  it.each([
    {
      name: "prints requestId-aware recovery guidance when gateway pairing is required",
      error: "connect failed: pairing required (requestId: req-123)",
      closeReason: "pairing required (requestId: req-123)",
      includes: ["devices approve req-123"],
      excludes: [],
    },
    {
      name: "prints fallback recovery guidance when pairing requestId is unavailable",
      error: "connect failed: pairing required",
      closeReason: "connect failed",
      includes: [],
      excludes: ["devices approve req-"],
    },
    {
      name: "does not render unsafe requestId content into approval command hints",
      error: "connect failed: pairing required (requestId: req-123;rm -rf /)",
      closeReason: "pairing required (requestId: req-123;rm -rf /)",
      includes: [],
      excludes: ["devices approve req-123;rm -rf /"],
    },
  ])("$name", async ({ error, closeReason, includes, excludes }) => {
    mockProbeGatewayResult({
      error,
      close: { code: 1008, reason: closeReason },
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("Gateway pairing approval required.");
    expect(joined).toContain("devices approve --latest");
    expect(joined).toContain("devices list");
    for (const expected of includes) {
      expect(joined).toContain(expected);
    }
    for (const blocked of excludes) {
      expect(joined).not.toContain(blocked);
    }
  });

  it("extracts requestId from close reason when error text omits it", async () => {
    mockProbeGatewayResult({
      error: "connect failed: pairing required",
      close: { code: 1008, reason: "pairing required (requestId: req-close-456)" },
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("devices approve req-close-456");
  });

  it("includes sessions across agents in JSON output", async () => {
    const originalAgents = mocks.listAgentsForGateway.getMockImplementation();
    const originalResolveStorePath = mocks.resolveStorePath.getMockImplementation();
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();

    mocks.listAgentsForGateway.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    });
    mocks.resolveStorePath.mockImplementation((_store, opts) =>
      opts?.agentId === "ops" ? "/tmp/ops.json" : "/tmp/main.json",
    );
    mocks.loadSessionStore.mockImplementation((storePath) => {
      if (storePath === "/tmp/ops.json") {
        return {
          "agent:ops:main": {
            updatedAt: Date.now() - 120_000,
            inputTokens: 1_000,
            outputTokens: 1_000,
            totalTokens: 2_000,
            contextTokens: 10_000,
            model: "pi:opus",
          },
        };
      }
      return {
        "+1000": createDefaultSessionStoreEntry(),
      };
    });

    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.sessions.count).toBe(2);
    expect(payload.sessions.paths.length).toBe(2);
    expect(
      payload.sessions.recent.some((sess: { key?: string }) => sess.key === "agent:ops:main"),
    ).toBe(true);

    if (originalAgents) {
      mocks.listAgentsForGateway.mockImplementation(originalAgents);
    }
    if (originalResolveStorePath) {
      mocks.resolveStorePath.mockImplementation(originalResolveStorePath);
    }
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  });
});
