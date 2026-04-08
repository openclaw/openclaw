import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { bootstrapCommand, buildBootstrapDiagnostics } from "./bootstrap-external.js";

const promptMocks = vi.hoisted(() => {
  const cancelSignal = Symbol("clack-cancel");
  return {
    cancelSignal,
    confirmDecision: false as boolean | symbol,
    confirmDecisions: [] as Array<boolean | symbol>,
    selectValue: "" as string | symbol,
    textValue: "" as string | symbol,
    confirm: vi.fn(async () => false as boolean | symbol),
    select: vi.fn(async () => "" as string | symbol),
    text: vi.fn(async () => "" as string | symbol),
    isCancel: vi.fn((value: unknown) => value === cancelSignal),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  };
});

vi.mock("@clack/prompts", () => ({
  confirm: promptMocks.confirm,
  select: promptMocks.select,
  text: promptMocks.text,
  isCancel: promptMocks.isCancel,
  spinner: promptMocks.spinner,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("./web-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-runtime.js")>();
  return {
    ...actual,
    ensureManagedWebRuntime: async (params: { port: number }) => {
      const result = await actual.probeWebRuntime(params.port);
      return { ready: result.ok, reason: result.reason };
    },
  };
});

type SpawnCall = {
  command: string;
  args: string[];
  options?: { stdio?: unknown; env?: NodeJS.ProcessEnv };
};

function createWebProfilesResponse(params?: {
  status?: number;
  payload?: { profiles?: unknown[]; activeProfile?: string | null };
}): Response {
  const status = params?.status ?? 200;
  const payload = params?.payload ?? { profiles: [], activeProfile: "dench" };
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  } as unknown as Response;
}

function createJsonResponse(params?: {
  status?: number;
  payload?: unknown;
}): Response {
  const status = params?.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => params?.payload ?? {},
  } as unknown as Response;
}

function createTempStateDir(): string {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(os.tmpdir(), `denchclaw-bootstrap-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBootstrapFixtures(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const config = {
    agents: {
      defaults: {
        model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
      },
    },
    gateway: {
      mode: "local",
    },
  };
  writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));

  const authDir = path.join(stateDir, "agents", "main", "agent");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(
    path.join(authDir, "auth-profiles.json"),
    JSON.stringify({
      profiles: {
        "vercel-ai-gateway:default": {
          provider: "vercel-ai-gateway",
          key: "vck_test_123",
        },
      },
    }),
  );
}

function parseConfigSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    if (raw === "true") return true;
    if (raw === "false") return false;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && raw.trim() !== "") {
      return numeric;
    }
    return raw;
  }
}

function applyConfigSet(stateDir: string, keyPath: string, rawValue: string): void {
  const configPath = path.join(stateDir, "openclaw.json");
  const current = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8"))
    : {};
  const segments = keyPath.split(".");
  let cursor: Record<string, unknown> = current;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf) {
    cursor[leaf] = parseConfigSetValue(rawValue);
  }
  writeFileSync(configPath, JSON.stringify(current));
}

function createPendingDeviceRequest(params: {
  requestId: string;
  deviceId: string;
  createdAtMs?: number;
  platform?: string;
  clientId?: string;
  clientMode?: string;
}): Record<string, unknown> {
  return {
    requestId: params.requestId,
    deviceId: params.deviceId,
    platform: params.platform ?? process.platform,
    clientId: params.clientId ?? "cli",
    clientMode: params.clientMode ?? "cli",
    role: "operator",
    roles: ["operator"],
    scopes: [
      "operator.admin",
      "operator.approvals",
      "operator.pairing",
      "operator.read",
      "operator.write",
    ],
    createdAtMs: params.createdAtMs ?? Date.now(),
  };
}

function createMockChild(params: {
  code: number;
  stdout?: string;
  stderr?: string;
}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();

  queueMicrotask(() => {
    if (params.stdout) {
      child.stdout.emit("data", Buffer.from(params.stdout));
    }
    if (params.stderr) {
      child.stderr.emit("data", Buffer.from(params.stderr));
    }
    child.emit("close", params.code);
  });

  return child;
}

async function withForcedStdinTty<T>(isTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: isTTY });
  try {
    return await fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }
}

describe("bootstrapCommand always-onboard behavior", () => {
  const originalEnv = { ...process.env };
  const spawnMock = vi.mocked(spawn);
  let homeDir = "";
  let stateDir = "";
  let spawnCalls: SpawnCall[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;
  let fetchBehavior: (url: string) => Promise<Response>;
  let forceGlobalMissing = false;
  let globalDetectCount = 0;
  let openClawVersionOutput = "2026.3.1\n";
  let healthFailuresBeforeSuccess = 0;
  let healthCallCount = 0;
  let alwaysHealthFail = false;
  let gatewayModeConfigValue = "local\n";
  let driftGatewayModeAfterOnboard = false;
  let pendingDeviceRequests: Array<Record<string, unknown>> = [];
  let pairedDevices: Array<Record<string, unknown>> = [];
  let approvedDeviceRequestIds: string[] = [];

  beforeEach(() => {
    homeDir = createTempStateDir();
    stateDir = path.join(homeDir, ".openclaw-dench");
    writeBootstrapFixtures(stateDir);
    spawnCalls = [];
    forceGlobalMissing = false;
    globalDetectCount = 0;
    openClawVersionOutput = "2026.3.1\n";
    healthFailuresBeforeSuccess = 0;
    healthCallCount = 0;
    alwaysHealthFail = false;
    gatewayModeConfigValue = "local\n";
    driftGatewayModeAfterOnboard = false;
    pendingDeviceRequests = [];
    pairedDevices = [];
    approvedDeviceRequestIds = [];
    process.env = {
      ...originalEnv,
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_PROFILE: "dench",
      OPENCLAW_STATE_DIR: stateDir,
      VITEST: "true",
    };
    promptMocks.confirmDecision = false;
    promptMocks.confirmDecisions = [];
    promptMocks.selectValue = "gpt-5.4";
    promptMocks.textValue = "dench_test_key";
    promptMocks.confirm.mockReset();
    promptMocks.confirm.mockImplementation(async () =>
      promptMocks.confirmDecisions.length > 0
        ? promptMocks.confirmDecisions.shift()!
        : promptMocks.confirmDecision
    );
    promptMocks.select.mockReset();
    promptMocks.select.mockImplementation(async () => promptMocks.selectValue);
    promptMocks.text.mockReset();
    promptMocks.text.mockImplementation(async () => promptMocks.textValue);
    promptMocks.isCancel.mockReset();
    promptMocks.isCancel.mockImplementation((value: unknown) => value === promptMocks.cancelSignal);
    promptMocks.spinner.mockClear();

    spawnMock.mockImplementation((command, args = [], options) => {
      const commandString = String(command);
      const argList = Array.isArray(args) ? args.map(String) : [];
      spawnCalls.push({
        command: commandString,
        args: argList,
        options: options as { stdio?: unknown } | undefined,
      });

      if (commandString === "openclaw" && argList[0] === "--version") {
        return createMockChild({ code: 0, stdout: openClawVersionOutput }) as never;
      }
      if (
        commandString === "npm" &&
        argList.includes("ls") &&
        argList.includes("-g") &&
        argList.includes("openclaw")
      ) {
        globalDetectCount += 1;
        const reportMissing = forceGlobalMissing && globalDetectCount === 1;
        return createMockChild({
          code: reportMissing ? 1 : 0,
          stdout: reportMissing
            ? '{"dependencies":{}}'
            : '{"dependencies":{"openclaw":{"version":"2026.3.1"}}}',
        }) as never;
      }
      if (commandString === "npm" && argList.includes("prefix") && argList.includes("-g")) {
        return createMockChild({
          code: 0,
          stdout: `${path.join(stateDir, "npm-global")}\n`,
        }) as never;
      }
      if (commandString === "npm" && argList.includes("install") && argList.includes("-g")) {
        return createMockChild({ code: 0, stdout: "installed\n" }) as never;
      }
      if ((commandString === "which" || commandString === "where") && argList[0] === "openclaw") {
        return createMockChild({ code: 0, stdout: "/usr/local/bin/openclaw\n" }) as never;
      }
      if (
        commandString === "openclaw" &&
        argList.includes("config") &&
        argList.includes("get") &&
        argList.includes("gateway.mode")
      ) {
        return createMockChild({ code: 0, stdout: gatewayModeConfigValue }) as never;
      }
      if (
        commandString === "openclaw" &&
        argList.includes("config") &&
        argList.includes("set") &&
        argList.includes("gateway.mode")
      ) {
        gatewayModeConfigValue = `${argList.at(-1) ?? ""}\n`;
        return createMockChild({ code: 0, stdout: "ok\n" }) as never;
      }
      if (commandString === "openclaw" && argList.includes("onboard")) {
        if (driftGatewayModeAfterOnboard) {
          gatewayModeConfigValue = "remote\n";
        }
        return createMockChild({ code: 0, stdout: "ok\n" }) as never;
      }
      if (commandString === "openclaw" && argList.includes("devices") && argList.includes("list")) {
        return createMockChild({
          code: 0,
          stdout: `${JSON.stringify({ pending: pendingDeviceRequests, paired: pairedDevices })}\n`,
        }) as never;
      }
      if (commandString === "openclaw" && argList.includes("devices") && argList.includes("approve")) {
        const requestId = argList.at(-1) ?? "";
        const match = pendingDeviceRequests.find((entry) => entry.requestId === requestId);
        if (!match) {
          return createMockChild({
            code: 1,
            stderr: `request not found: ${requestId}\n`,
          }) as never;
        }
        pendingDeviceRequests = pendingDeviceRequests.filter((entry) => entry.requestId !== requestId);
        pairedDevices = [
          ...pairedDevices,
          {
            ...match,
            approvedAtMs: typeof match.createdAtMs === "number" ? match.createdAtMs : Date.now(),
          },
        ];
        approvedDeviceRequestIds.push(requestId);
        return createMockChild({
          code: 0,
          stdout: `Approved ${String(match.deviceId ?? "device")} (${requestId})\n`,
        }) as never;
      }
      if (
        commandString === "openclaw" &&
        argList.includes("config") &&
        argList.includes("set")
      ) {
        const setIndex = argList.lastIndexOf("set");
        const keyPath = argList[setIndex + 1];
        const rawValue = argList[setIndex + 2];
        if (keyPath && rawValue !== undefined) {
          applyConfigSet(stateDir, keyPath, rawValue);
        }
        return createMockChild({ code: 0, stdout: "ok\n" }) as never;
      }
      if (commandString === "openclaw" && argList.includes("health")) {
        healthCallCount += 1;
        if (alwaysHealthFail || healthCallCount <= healthFailuresBeforeSuccess) {
          return createMockChild({
            code: 1,
            stderr: "gateway closed (1006 abnormal closure)\n",
          }) as never;
        }
        return createMockChild({ code: 0, stdout: '{"ok":true}\n' }) as never;
      }
      return createMockChild({ code: 0, stdout: "ok\n" }) as never;
    });

    fetchBehavior = async (url: string) => {
      if (url.includes("/api/profiles")) {
        return createWebProfilesResponse();
      }
      return createWebProfilesResponse({ status: 404, payload: {} });
    };
    fetchMock = vi.fn(async (input: unknown) => {
      let url = "";
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else if (input && typeof input === "object" && "url" in input) {
        const requestUrl = (input as { url?: unknown }).url;
        if (typeof requestUrl === "string") {
          url = requestUrl;
        } else if (requestUrl instanceof URL) {
          url = requestUrl.toString();
        }
      }
      return await fetchBehavior(url);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(homeDir || stateDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs onboard every bootstrap even when config already exists (prevents stale auth drift)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardCalls = spawnCalls.filter(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCalls).toHaveLength(1);
    expect(onboardCalls[0]?.args).toEqual(
      expect.arrayContaining([
        "--profile",
        "dench",
        "onboard",
        "--install-daemon",
        "--non-interactive",
        "--accept-risk",
        "--skip-ui",
      ]),
    );
    expect(onboardCalls[0]?.options?.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(summary.onboarded).toBe(true);
  });

  it("stages gateway.mode=local in raw JSON before onboard so first daemon start does not drift (no CLI calls pre-profile)", async () => {
    gatewayModeConfigValue = "\n";
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const configPath = path.join(stateDir, "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.gateway?.mode).toBe("local");

    const preOnboardGatewayModeCliSet = spawnCalls.findIndex((call, index) => {
      const onboardIndex = spawnCalls.findIndex(
        (c) => c.command === "openclaw" && c.args.includes("onboard"),
      );
      return (
        index < onboardIndex &&
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("gateway.mode")
      );
    });
    expect(preOnboardGatewayModeCliSet).toBe(-1);
  });

  it("stages gateway.port in raw JSON before onboard so first daemon start uses DenchClaw's port (no CLI calls pre-profile)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const configPath = path.join(stateDir, "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.gateway?.port).toBeGreaterThanOrEqual(19001);

    const preOnboardGatewayPortCliSet = spawnCalls.findIndex((call, index) => {
      const onboardIndex = spawnCalls.findIndex(
        (c) => c.command === "openclaw" && c.args.includes("onboard"),
      );
      return (
        index < onboardIndex &&
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("gateway.port")
      );
    });
    expect(preOnboardGatewayPortCliSet).toBe(-1);
  });

  it("enforces gateway.mode=local via CLI after onboard when onboarding drifts it away from local", async () => {
    gatewayModeConfigValue = "\n";
    driftGatewayModeAfterOnboard = true;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardIndex = spawnCalls.findIndex(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    const postOnboardModeSet = spawnCalls.findIndex(
      (call, index) =>
        index > onboardIndex &&
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("gateway.mode") &&
        call.args.includes("local"),
    );

    expect(onboardIndex).toBeGreaterThan(-1);
    expect(postOnboardModeSet).toBeGreaterThan(onboardIndex);
  });

  it("applies gateway.port via CLI after onboard so onboarding defaults cannot desync DenchClaw's gateway target", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardIndex = spawnCalls.findIndex(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    const postOnboardPortSet = spawnCalls.findIndex(
      (call, index) =>
        index > onboardIndex &&
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("gateway.port"),
    );

    expect(onboardIndex).toBeGreaterThan(-1);
    expect(postOnboardPortSet).toBeGreaterThan(onboardIndex);
  });

  it("ignores bootstrap --profile override and keeps dench profile (prevents profile drift)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    process.env.OPENCLAW_PROFILE = "dench";

    const summary = await bootstrapCommand(
      {
        profile: "team-a",
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardCall = spawnCalls.find(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCall?.args).toEqual(expect.arrayContaining(["--profile", "dench"]));
    expect(onboardCall?.args.includes("team-a")).toBe(false);
    expect(summary.profile).toBe("dench");
  });

  it("adds --reset to onboarding args when --force-onboard is requested", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        forceOnboard: true,
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardCall = spawnCalls.find(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCall?.args).toContain("--reset");
  });

  it("uses bootstrap-owned Dench Cloud setup and skips OpenClaw auth onboarding", async () => {
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
          },
        },
        gateway: { mode: "local" },
        plugins: {
          allow: ["dench-cloud-provider"],
          load: {
            paths: [path.join(stateDir, "extensions", "dench-cloud-provider")],
          },
          entries: {
            "dench-cloud-provider": {
              enabled: true,
            },
          },
        },
      }),
    );
    mkdirSync(path.join(stateDir, "extensions", "dench-cloud-provider"), { recursive: true });
    writeFileSync(
      path.join(stateDir, "extensions", "dench-cloud-provider", "index.ts"),
      "export {};\n",
    );
    fetchBehavior = async (url: string) => {
      if (url.includes("gateway.merseoriginals.com/v1/models")) {
        return createJsonResponse({ status: 200, payload: { object: "list", data: [] } });
      }
      if (url.includes("gateway.merseoriginals.com/v1/public/models")) {
        return createJsonResponse({
          status: 200,
          payload: {
            object: "list",
            data: [
              {
                id: "gpt-5.4",
                stableId: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                transportProvider: "openai",
                input: ["text", "image"],
                contextWindow: 128000,
                maxTokens: 128000,
                supportsStreaming: true,
                supportsImages: true,
                supportsResponses: true,
                supportsReasoning: false,
                cost: {
                  input: 3.375,
                  output: 20.25,
                  cacheRead: 0,
                  cacheWrite: 0,
                  marginPercent: 0.35,
                },
              },
              {
                id: "claude-opus-4.6",
                stableId: "anthropic.claude-opus-4-6-v1",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                transportProvider: "bedrock",
                input: ["text", "image"],
                contextWindow: 200000,
                maxTokens: 64000,
                supportsStreaming: true,
                supportsImages: true,
                supportsResponses: true,
                supportsReasoning: false,
                cost: {
                  input: 6.75,
                  output: 33.75,
                  cacheRead: 0,
                  cacheWrite: 0,
                  marginPercent: 0.35,
                },
              },
            ],
          },
        });
      }
      if (url.includes("/api/profiles")) {
        return createWebProfilesResponse();
      }
      return createJsonResponse({ status: 404, payload: {} });
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
        denchCloud: true,
        denchCloudApiKey: "dench_live_key",
        denchCloudModel: "anthropic.claude-opus-4-6-v1",
      },
      runtime,
    );

    const onboardCall = spawnCalls.find(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCall?.args).toEqual(
      expect.arrayContaining([
        "--profile",
        "dench",
        "onboard",
        "--non-interactive",
        "--auth-choice",
        "skip",
      ]),
    );

    const updatedConfig = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"));
    expect(updatedConfig.models.providers["dench-cloud"].apiKey).toBe("dench_live_key");
    expect(updatedConfig.agents.defaults.model.primary).toBe(
      "dench-cloud/anthropic.claude-opus-4-6-v1",
    );
    expect(updatedConfig.agents.defaults.models["dench-cloud/anthropic.claude-opus-4-6-v1"]).toEqual(
      expect.objectContaining({ alias: "Claude Opus 4.6 (Dench Cloud)" }),
    );
    expect(updatedConfig.plugins.allow).toContain("posthog-analytics");
    expect(updatedConfig.plugins.allow).toContain("dench-ai-gateway");
    expect(updatedConfig.plugins.allow).not.toContain("dench-cloud-provider");
    expect(updatedConfig.plugins.entries["dench-cloud-provider"]).toBeUndefined();
    expect(updatedConfig.plugins.entries["dench-ai-gateway"]).toEqual(
      expect.objectContaining({
        enabled: true,
        config: expect.objectContaining({
          gatewayUrl: "https://gateway.merseoriginals.com",
        }),
      }),
    );
    expect(updatedConfig.plugins.installs["posthog-analytics"]).toEqual(
      expect.objectContaining({
        source: "path",
        installPath: expect.stringContaining(path.join("extensions", "posthog-analytics")),
      }),
    );
    expect(updatedConfig.plugins.installs["dench-ai-gateway"]).toEqual(
      expect.objectContaining({
        source: "path",
        installPath: expect.stringContaining(path.join("extensions", "dench-ai-gateway")),
      }),
    );
    expect(updatedConfig.plugins.entries["exa-search"]).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(updatedConfig.plugins.entries["apollo-enrichment"]).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(updatedConfig.tools.web.search.enabled).toBe(false);
    expect(updatedConfig.tools.deny).toContain("web_search");
    expect(updatedConfig.messages.tts.provider).toBe("elevenlabs");
    expect(updatedConfig.messages.tts.elevenlabs).toEqual(
      expect.objectContaining({
        baseUrl: "https://gateway.merseoriginals.com",
        apiKey: "dench_live_key",
      }),
    );
    const integrationsMetadata = JSON.parse(
      readFileSync(path.join(stateDir, ".dench-integrations.json"), "utf-8"),
    );
    expect(integrationsMetadata.exa).toEqual({
      ownsSearch: true,
      fallbackProvider: "duckduckgo",
    });
    expect(existsSync(path.join(stateDir, "extensions", "dench-cloud-provider"))).toBe(false);
    expect(existsSync(path.join(stateDir, "extensions", "shared", "dench-auth.ts"))).toBe(true);
  });

  it("uses providers-wrapped ElevenLabs config for modern OpenClaw versions", async () => {
    openClawVersionOutput = "2026.4.5\n";
    fetchBehavior = async (url: string) => {
      if (url.includes("gateway.merseoriginals.com/v1/models")) {
        return createJsonResponse({
          status: 200,
          payload: {
            object: "list",
            data: [
              {
                id: "claude-opus-4.6",
                stableId: "anthropic.claude-opus-4-6-v1",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                transportProvider: "bedrock",
                input: ["text", "image"],
                contextWindow: 200000,
                maxTokens: 64000,
                supportsStreaming: true,
                supportsImages: true,
                supportsResponses: true,
                supportsReasoning: false,
                cost: {
                  input: 6.75,
                  output: 33.75,
                  cacheRead: 0,
                  cacheWrite: 0,
                  marginPercent: 0.35,
                },
              },
            ],
          },
        });
      }
      if (url.includes("/api/profiles")) {
        return createWebProfilesResponse();
      }
      return createJsonResponse({ status: 404, payload: {} });
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
        denchCloud: true,
        denchCloudApiKey: "dench_live_key",
        denchCloudModel: "anthropic.claude-opus-4-6-v1",
      },
      runtime,
    );

    const updatedConfig = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"));
    expect(updatedConfig.messages.tts.provider).toBe("elevenlabs");
    expect(updatedConfig.messages.tts.providers.elevenlabs).toEqual(
      expect.objectContaining({
        baseUrl: "https://gateway.merseoriginals.com",
        apiKey: "dench_live_key",
      }),
    );
    expect(updatedConfig.messages.tts.elevenlabs).toBeUndefined();
  });

  it("falls back to DenchClaw's bundled model list when the public gateway catalog is unavailable", async () => {
    fetchBehavior = async (url: string) => {
      if (url.includes("gateway.merseoriginals.com/v1/models")) {
        return createJsonResponse({ status: 200, payload: { object: "list", data: [] } });
      }
      if (url.includes("gateway.merseoriginals.com/v1/public/models")) {
        return createJsonResponse({ status: 503, payload: {} });
      }
      if (url.includes("/api/profiles")) {
        return createWebProfilesResponse();
      }
      return createJsonResponse({ status: 404, payload: {} });
    };
    promptMocks.textValue = "dench_retry_key";
    promptMocks.selectValue = "anthropic.claude-sonnet-4-6-v1";
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        denchCloud: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(promptMocks.text).toHaveBeenCalledTimes(1);
    expect(promptMocks.select).toHaveBeenCalledTimes(1);
    const onboardCall = spawnCalls.find(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCall?.options?.stdio).toBe("inherit");
    expect(onboardCall?.args).toEqual(expect.arrayContaining(["--auth-choice", "skip"]));
    expect(onboardCall?.args).not.toContain("--non-interactive");
    const updatedConfig = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"));
    expect(updatedConfig.agents.defaults.model.primary).toBe(
      "dench-cloud/anthropic.claude-sonnet-4-6-v1",
    );
    expect(updatedConfig.models.providers["dench-cloud"].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.4" }),
        expect.objectContaining({ id: "anthropic.claude-opus-4-6-v1" }),
        expect.objectContaining({ id: "anthropic.claude-sonnet-4-6-v1" }),
      ]),
    );
  });

  it("keeps Dench-only integrations off when Dench Cloud is declined", async () => {
    promptMocks.confirmDecision = false;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await withForcedStdinTty(true, async () => {
      await bootstrapCommand(
        {
          noOpen: true,
          skipUpdate: true,
        },
        runtime,
      );
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("D E N C H   C L O U D"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("App Integrations"));
    expect(promptMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Continue with Dench Cloud? Recommended. API key: dench.com/api"),
      }),
    );

    const updatedConfig = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"));
    expect(updatedConfig.plugins.entries["exa-search"]).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(updatedConfig.plugins.entries["apollo-enrichment"]).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(updatedConfig.tools.web.search.enabled).toBe(true);
    expect(updatedConfig.tools.deny ?? []).not.toContain("web_search");
    expect(updatedConfig.messages?.tts?.provider).toBeUndefined();
    expect(updatedConfig.messages?.tts?.elevenlabs).toBeUndefined();
    const integrationsMetadata = JSON.parse(
      readFileSync(path.join(stateDir, ".dench-integrations.json"), "utf-8"),
    );
    expect(integrationsMetadata.exa).toEqual({
      ownsSearch: false,
      fallbackProvider: "duckduckgo",
    });
  });

  it("re-prompts for Dench Cloud every bootstrap and pre-fills the saved key and model", async () => {
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "dench-cloud/anthropic.claude-opus-4-6-v1" },
          },
        },
        models: {
          providers: {
            "dench-cloud": {
              baseUrl: "https://gateway.merseoriginals.com/v1",
              apiKey: "dench_saved_key",
            },
          },
        },
        gateway: { mode: "local" },
      }),
    );
    fetchBehavior = async (url: string) => {
      if (url.includes("gateway.merseoriginals.com/v1/models")) {
        return createJsonResponse({ status: 200, payload: { object: "list", data: [] } });
      }
      if (url.includes("gateway.merseoriginals.com/v1/public/models")) {
        return createJsonResponse({
          status: 200,
          payload: {
            object: "list",
            data: [
              {
                id: "gpt-5.4",
                stableId: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                transportProvider: "openai",
                input: ["text", "image"],
                contextWindow: 128000,
                maxTokens: 128000,
                supportsStreaming: true,
                supportsImages: true,
                supportsResponses: true,
                supportsReasoning: false,
                cost: {
                  input: 3.375,
                  output: 20.25,
                  cacheRead: 0,
                  cacheWrite: 0,
                  marginPercent: 0.35,
                },
              },
              {
                id: "claude-opus-4.6",
                stableId: "anthropic.claude-opus-4-6-v1",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                transportProvider: "bedrock",
                input: ["text", "image"],
                contextWindow: 200000,
                maxTokens: 64000,
                supportsStreaming: true,
                supportsImages: true,
                supportsResponses: true,
                supportsReasoning: false,
                cost: {
                  input: 6.75,
                  output: 33.75,
                  cacheRead: 0,
                  cacheWrite: 0,
                  marginPercent: 0.35,
                },
              },
            ],
          },
        });
      }
      if (url.includes("/api/profiles")) {
        return createWebProfilesResponse();
      }
      return createJsonResponse({ status: 404, payload: {} });
    };
    promptMocks.confirmDecision = true;
    promptMocks.textValue = "dench_saved_key";
    promptMocks.selectValue = "anthropic.claude-opus-4-6-v1";
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await withForcedStdinTty(true, async () => {
      await bootstrapCommand(
        {
          noOpen: true,
          skipUpdate: true,
        },
        runtime,
      );
    });

    expect(promptMocks.confirm).toHaveBeenCalledTimes(1);
    expect(promptMocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "dench_saved_key",
      }),
    );
    expect(promptMocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "anthropic.claude-opus-4-6-v1",
      }),
    );

    const onboardCall = spawnCalls.find(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCall?.options?.stdio).toBe("inherit");
    expect(onboardCall?.args).toEqual(expect.arrayContaining(["--auth-choice", "skip"]));
    expect(onboardCall?.args).not.toContain("--non-interactive");
  });

  it("runs update before onboarding when --update-now is set", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        updateNow: true,
      },
      runtime,
    );

    const updateIndex = spawnCalls.findIndex(
      (call) =>
        call.command === "openclaw" && call.args.includes("update") && call.args.includes("--yes"),
    );
    const onboardIndex = spawnCalls.findIndex(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(onboardIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeLessThan(onboardIndex);
  });

  it("runs update before onboarding when interactive prompt is accepted", async () => {
    promptMocks.confirmDecisions = [true, false];
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await withForcedStdinTty(true, async () => {
      await bootstrapCommand(
        {
          noOpen: true,
        },
        runtime,
      );
    });

    expect(promptMocks.confirm).toHaveBeenCalledTimes(2);
    const updateIndex = spawnCalls.findIndex(
      (call) =>
        call.command === "openclaw" && call.args.includes("update") && call.args.includes("--yes"),
    );
    const onboardIndex = spawnCalls.findIndex(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(onboardIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeLessThan(onboardIndex);
  });

  it("skips update prompt right after installing openclaw@latest (avoids redundant update checks)", async () => {
    forceGlobalMissing = true;
    promptMocks.confirmDecision = false;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await withForcedStdinTty(true, async () => {
      await bootstrapCommand(
        {
          noOpen: true,
        },
        runtime,
      );
    });

    const installedGlobalOpenClaw = spawnCalls.some(
      (call) =>
        call.command === "npm" &&
        call.args.includes("install") &&
        call.args.includes("-g") &&
        call.args.includes("openclaw@latest"),
    );
    const updateCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("update") && call.args.includes("--yes"),
    );

    expect(installedGlobalOpenClaw).toBe(true);
    expect(promptMocks.confirm).toHaveBeenCalledTimes(1);
    expect(updateCalled).toBe(false);
  });

  it("skips update when interactive prompt is declined", async () => {
    promptMocks.confirmDecisions = [false, false];
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await withForcedStdinTty(true, async () => {
      await bootstrapCommand(
        {
          noOpen: true,
        },
        runtime,
      );
    });

    expect(promptMocks.confirm).toHaveBeenCalledTimes(2);
    const updateCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("update") && call.args.includes("--yes"),
    );
    const onboardCalls = spawnCalls.filter(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );

    expect(updateCalled).toBe(false);
    expect(onboardCalls).toHaveLength(1);
  });

  it("reuses recent OpenClaw CLI availability checks to avoid repeated npm/which probes", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const firstProbeCounts = {
      npmLs: spawnCalls.filter(
        (call) =>
          call.command === "npm" &&
          call.args.includes("ls") &&
          call.args.includes("-g") &&
          call.args.includes("openclaw"),
      ).length,
      npmPrefix: spawnCalls.filter(
        (call) =>
          call.command === "npm" && call.args.includes("prefix") && call.args.includes("-g"),
      ).length,
      shellWhich: spawnCalls.filter(
        (call) =>
          (call.command === "which" || call.command === "where") && call.args[0] === "openclaw",
      ).length,
      versionCheck: spawnCalls.filter(
        (call) => call.command === "openclaw" && call.args[0] === "--version",
      ).length,
    };

    spawnCalls = [];

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const secondProbeCounts = {
      npmLs: spawnCalls.filter(
        (call) =>
          call.command === "npm" &&
          call.args.includes("ls") &&
          call.args.includes("-g") &&
          call.args.includes("openclaw"),
      ).length,
      npmPrefix: spawnCalls.filter(
        (call) =>
          call.command === "npm" && call.args.includes("prefix") && call.args.includes("-g"),
      ).length,
      shellWhich: spawnCalls.filter(
        (call) =>
          (call.command === "which" || call.command === "where") && call.args[0] === "openclaw",
      ).length,
      versionCheck: spawnCalls.filter(
        (call) => call.command === "openclaw" && call.args[0] === "--version",
      ).length,
    };

    expect(firstProbeCounts.npmLs).toBeGreaterThan(0);
    expect(firstProbeCounts.npmPrefix).toBeGreaterThan(0);
    expect(firstProbeCounts.shellWhich).toBeGreaterThan(0);
    expect(firstProbeCounts.versionCheck).toBeGreaterThan(0);
    expect(secondProbeCounts).toEqual({
      npmLs: 0,
      npmPrefix: 0,
      shellWhich: 0,
      versionCheck: 0,
    });
  });

  it("seeds workspace.duckdb on bootstrap when missing", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const workspaceDir = path.join(stateDir, "workspace");
    const workspaceDbPath = path.join(workspaceDir, "workspace.duckdb");
    expect(existsSync(workspaceDbPath)).toBe(false);

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(existsSync(workspaceDbPath)).toBe(true);
    expect(summary.workspaceSeed?.seeded).toBe(true);
    expect(summary.workspaceSeed?.reason).toBe("seeded");
    expect(summary.workspaceSeed?.workspaceDir).toBe(workspaceDir);
  });

  it("skips workspace seeding when workspace.duckdb already exists", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const workspaceDir = path.join(stateDir, "workspace");
    const workspaceDbPath = path.join(workspaceDir, "workspace.duckdb");
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(workspaceDbPath, "existing-db-content", "utf-8");
    writeFileSync(identityPath, "# stale identity\n", "utf-8");

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(summary.workspaceSeed?.seeded).toBe(false);
    expect(summary.workspaceSeed?.reason).toBe("already-exists");
    expect(readFileSync(workspaceDbPath, "utf-8")).toBe("existing-db-content");
    const identityContent = readFileSync(identityPath, "utf-8");
    expect(identityContent).toBe("# stale identity\n");
  });

  it("ignores custom config workspace and seeds the managed default workspace", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const customWorkspace = path.join(stateDir, "seed-projection-workspace");
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
            workspace: customWorkspace,
          },
        },
        gateway: { mode: "local" },
      }),
    );

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const managedWorkspace = path.join(stateDir, "workspace");
    expect(summary.workspaceSeed?.seeded).toBe(true);
    expect(summary.workspaceSeed?.workspaceDir).toBe(managedWorkspace);
    expect(existsSync(path.join(managedWorkspace, "people", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(managedWorkspace, "company", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(managedWorkspace, "task", ".object.yaml"))).toBe(true);
    expect(existsSync(path.join(managedWorkspace, "WORKSPACE.md"))).toBe(true);
    expect(existsSync(path.join(managedWorkspace, "IDENTITY.md"))).toBe(false);
  });

  it("installs CRM skill into managed workspace skills directory (prevents state-root drift)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const targetSkill = path.join(stateDir, "workspace", "skills", "crm", "SKILL.md");
    const legacySkill = path.join(stateDir, "skills", "crm", "SKILL.md");
    expect(existsSync(targetSkill)).toBe(false);

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(existsSync(targetSkill)).toBe(true);
    expect(existsSync(legacySkill)).toBe(false);
    expect(readFileSync(targetSkill, "utf-8")).toContain("name: database-crm-system");
  });

  it("replaces existing managed CRM skill on bootstrap (keeps updates in sync)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const targetDir = path.join(stateDir, "workspace", "skills", "crm");
    const targetSkill = path.join(targetDir, "SKILL.md");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetSkill, "name: crm\n# custom\n");

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const content = readFileSync(targetSkill, "utf-8");
    expect(content).toContain("name: database-crm-system");
    expect(content).not.toContain("# custom");
  });

  it("pins workspace config to default workspace path during bootstrap", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const workspaceConfigSetCalls = spawnCalls.filter(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("agents.defaults.workspace"),
    );

    expect(workspaceConfigSetCalls.length).toBeGreaterThan(0);
    const lastArgs = workspaceConfigSetCalls.at(-1)?.args ?? [];
    expect(lastArgs).toEqual(
      expect.arrayContaining(["--profile", "dench", "config", "set", "agents.defaults.workspace"]),
    );
    const configuredWorkspace = lastArgs.at(-1) ?? "";
    expect(configuredWorkspace).toContain(path.join(".openclaw-dench", "workspace"));
    expect(configuredWorkspace).not.toContain("workspace-dench");
  });

  it("forces tools.profile to full during bootstrap (prevents messaging-only tool drift)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const toolsProfileSetCalls = spawnCalls.filter(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("tools.profile"),
    );

    expect(toolsProfileSetCalls.length).toBeGreaterThan(0);
    const lastArgs = toolsProfileSetCalls.at(-1)?.args ?? [];
    expect(lastArgs).toEqual(
      expect.arrayContaining(["--profile", "dench", "config", "set", "tools.profile", "full"]),
    );
    expect(lastArgs).not.toContain("messaging");
  });

  it("reapplies tools.profile full on repeated bootstrap runs (setup/restart safety)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );
    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const toolsProfileSetCalls = spawnCalls.filter(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("tools.profile"),
    );

    expect(toolsProfileSetCalls).toHaveLength(2);
    for (const call of toolsProfileSetCalls) {
      expect(call.args).toEqual(
        expect.arrayContaining(["--profile", "dench", "config", "set", "tools.profile", "full"]),
      );
    }
  });

  it("keeps CRM in managed skills even when workspace path is custom", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const customWorkspace = path.join(stateDir, "custom-workspace-root");
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
            workspace: customWorkspace,
          },
        },
        gateway: { mode: "local" },
      }),
    );
    const managedWorkspaceSkill = path.join(stateDir, "workspace", "skills", "crm", "SKILL.md");
    const customWorkspaceSkill = path.join(customWorkspace, "skills", "crm", "SKILL.md");

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(existsSync(managedWorkspaceSkill)).toBe(true);
    expect(existsSync(customWorkspaceSkill)).toBe(false);
  });

  it("uses inherited stdio for onboarding in interactive mode (shows wizard prompts)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardCalls = spawnCalls.filter(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardCalls).toHaveLength(1);
    expect(onboardCalls[0]?.options?.stdio).toBe("inherit");
    expect(onboardCalls[0]?.args).not.toContain("--non-interactive");
    expect(onboardCalls[0]?.args).toContain("--accept-risk");
    expect(onboardCalls[0]?.args).toContain("--skip-ui");
  });

  it("approves the pending local device request during bootstrap", async () => {
    pendingDeviceRequests = [
      createPendingDeviceRequest({
        requestId: "req-local-1",
        deviceId: "device-local-1",
      }),
    ];
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(approvedDeviceRequestIds).toEqual(["req-local-1"]);
    const approveCall = spawnCalls.find(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("devices") &&
        call.args.includes("approve") &&
        call.args.includes("req-local-1"),
    );
    expect(approveCall).toBeDefined();
  });

  it("rechecks the web runtime after approving a pending device request", async () => {
    pendingDeviceRequests = [
      createPendingDeviceRequest({
        requestId: "req-local-2",
        deviceId: "device-local-2",
      }),
    ];
    fetchBehavior = async (url: string) => {
      if (url.includes("/api/profiles")) {
        return approvedDeviceRequestIds.length > 0
          ? createWebProfilesResponse()
          : createWebProfilesResponse({ status: 503, payload: {} });
      }
      return createWebProfilesResponse({ status: 404, payload: {} });
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(approvedDeviceRequestIds).toEqual(["req-local-2"]);
    expect(summary.webReachable).toBe(true);
    const profileProbeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0] ?? "").includes("/api/profiles"),
    );
    expect(profileProbeCalls.length).toBeGreaterThan(1);
  });

  it("skips auto-approval when multiple equally likely device requests are pending", async () => {
    pendingDeviceRequests = [
      createPendingDeviceRequest({
        requestId: "req-ambiguous-1",
        deviceId: "device-ambiguous-1",
        createdAtMs: 1,
      }),
      createPendingDeviceRequest({
        requestId: "req-ambiguous-2",
        deviceId: "device-ambiguous-2",
        createdAtMs: 2,
      }),
    ];
    const logSpy = vi.fn();
    const runtime: RuntimeEnv = {
      log: logSpy,
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(approvedDeviceRequestIds).toEqual([]);
    const logMessages = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logMessages).toContain("Automatic device pairing skipped");
    expect(logMessages).toContain("devices list");
  });

  it("does not call gateway install/start fallback when onboarding is always used", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const gatewayInstallCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("gateway") &&
        call.args.includes("install"),
    );
    const gatewayStartCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("gateway") && call.args.includes("start"),
    );

    expect(gatewayInstallCalled).toBe(false);
    expect(gatewayStartCalled).toBe(false);
  });

  it("installs global OpenClaw even when a local binary already resolves", async () => {
    forceGlobalMissing = true;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const globalInstallCalls = spawnCalls.filter(
      (call) =>
        call.command === "npm" &&
        call.args.includes("install") &&
        call.args.includes("-g") &&
        call.args.includes("openclaw@latest"),
    );
    expect(globalInstallCalls.length).toBeGreaterThan(0);
    expect(summary.installedOpenClawCli).toBe(true);
  });

  it("recovers without autofix when gateway just needs a moment after restart (no false gateway-closed)", async () => {
    healthFailuresBeforeSuccess = 1;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const doctorFixCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("doctor") && call.args.includes("--fix"),
    );
    expect(doctorFixCalled).toBe(false);
    expect(summary.gatewayReachable).toBe(true);
    expect(summary.gatewayAutoFix).toBeUndefined();
  });

  it("performs one explicit gateway restart after all post-onboard config (no hidden restarts)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardIndex = spawnCalls.findIndex(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    const gatewayRestartCalls = spawnCalls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          call.command === "openclaw" &&
          call.args.includes("gateway") &&
          call.args.includes("restart"),
      );

    expect(onboardIndex).toBeGreaterThan(-1);
    expect(gatewayRestartCalls).toHaveLength(1);
    expect(gatewayRestartCalls[0]!.index).toBeGreaterThan(onboardIndex);
  });

  it("runs doctor/gateway autofix steps only after all retried probes fail", async () => {
    healthFailuresBeforeSuccess = 5;
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const doctorFixCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("doctor") && call.args.includes("--fix"),
    );
    const gatewayStopCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("gateway") && call.args.includes("stop"),
    );
    const gatewayInstallCalled = spawnCalls.some(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("gateway") &&
        call.args.includes("install") &&
        call.args.includes("--force"),
    );
    const gatewayRestartCalledInAutofix = spawnCalls.some(
      (call) =>
        call.command === "openclaw" && call.args.includes("gateway") && call.args.includes("restart"),
    );
    const toolsProfileSetCall = spawnCalls.find(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("tools.profile"),
    );

    expect(doctorFixCalled).toBe(true);
    expect(gatewayStopCalled).toBe(true);
    expect(gatewayInstallCalled).toBe(true);
    expect(gatewayRestartCalledInAutofix).toBe(true);
    expect(toolsProfileSetCall?.args).toEqual(
      expect.arrayContaining(["--profile", "dench", "config", "set", "tools.profile", "full"]),
    );
    expect(summary.gatewayReachable).toBe(true);
    expect(summary.gatewayAutoFix?.attempted).toBe(true);
    expect(summary.gatewayAutoFix?.recovered).toBe(true);
  });

  it("keeps preferred web port and does not probe sibling ports", async () => {
    let preferredPortChecks = 0;
    fetchBehavior = async (url: string) => {
      if (url.includes("127.0.0.1:3100/api/profiles")) {
        preferredPortChecks += 1;
        if (preferredPortChecks <= 2) {
          return createWebProfilesResponse({ status: 503, payload: {} });
        }
        return createWebProfilesResponse({
          status: 200,
          payload: { profiles: [], activeProfile: "dench" },
        });
      }
      if (url.includes("127.0.0.1:3101/api/profiles")) {
        return createWebProfilesResponse({
          status: 200,
          payload: { profiles: [{ id: "stale" }], activeProfile: "stale" },
        });
      }
      return createWebProfilesResponse({ status: 404, payload: {} });
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(summary.webUrl).toBe("http://localhost:3100");
    expect(fetchMock.mock.calls.some((call) => String(call[0] ?? "").includes(":3101/"))).toBe(
      false,
    );
  });

  it("accepts nullable activeProfile in /api/profiles payload (prevents first-run false-negative readiness)", async () => {
    fetchBehavior = async (url: string) => {
      if (url.includes("127.0.0.1:3100/api/profiles")) {
        return createWebProfilesResponse({
          status: 200,
          payload: { profiles: [], activeProfile: null },
        });
      }
      return createWebProfilesResponse({ status: 404, payload: {} });
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    expect(summary.webReachable).toBe(true);
    expect(summary.diagnostics.checks.find((check) => check.id === "web-ui")?.status).toBe("pass");
  });

  it("prints likely gateway cause with log excerpt when autofix cannot recover", async () => {
    alwaysHealthFail = true;
    mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    writeFileSync(
      path.join(stateDir, "logs", "gateway.err.log"),
      [
        "unauthorized: gateway token mismatch",
        "Invalid config",
        "plugins.slots.memory: plugin not found: memory-core",
      ].join("\n"),
    );

    const logSpy = vi.fn();
    const runtime: RuntimeEnv = {
      log: logSpy,
      error: vi.fn(),
      exit: vi.fn(),
    };

    const summary = await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );
    const logMessages = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");

    expect(summary.gatewayReachable).toBe(false);
    expect(summary.gatewayAutoFix?.attempted).toBe(true);
    expect(logMessages).toContain("Likely gateway cause:");
    expect(logMessages).toContain("gateway.err.log");
  });

  it("stages exec and elevated commands config in raw JSON before onboard (webchat gets host exec from first boot)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const configPath = path.join(stateDir, "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.tools?.exec?.security).toBe("full");
    expect(config.tools?.exec?.ask).toBe("off");
    expect(config.tools?.elevated?.enabled).toBe(true);
    expect(config.tools?.elevated?.allowFrom?.webchat).toEqual(["*"]);
    expect(config.commands?.bash).toBe(true);
    expect(config.commands?.config).toBe(true);
    expect(config.agents?.defaults?.elevatedDefault).toBe("on");

    const onboardIndex = spawnCalls.findIndex(
      (c) => c.command === "openclaw" && c.args.includes("onboard"),
    );
    const preOnboardElevatedCliSet = spawnCalls.findIndex((call, index) => {
      return (
        index < onboardIndex &&
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("tools.elevated.enabled")
      );
    });
    expect(preOnboardElevatedCliSet).toBe(-1);

    const preOnboardExecCliSet = spawnCalls.findIndex((call, index) => {
      return (
        index < onboardIndex &&
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        (call.args.includes("tools.exec.security") || call.args.includes("tools.exec.ask"))
      );
    });
    expect(preOnboardExecCliSet).toBe(-1);
  });

  it("applies exec and elevated commands via CLI after onboard (prevents onboard wizard drift)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const onboardIndex = spawnCalls.findIndex(
      (call) => call.command === "openclaw" && call.args.includes("onboard"),
    );
    expect(onboardIndex).toBeGreaterThan(-1);

    const elevatedSettings = [
      { key: "tools.exec.security", value: "full" },
      { key: "tools.exec.ask", value: "off" },
      { key: "tools.elevated.enabled", value: "true" },
      { key: "tools.elevated.allowFrom.webchat", value: '["*"]' },
      { key: "agents.defaults.elevatedDefault", value: "on" },
      { key: "commands.bash", value: "true" },
      { key: "commands.config", value: "true" },
    ];

    for (const { key, value } of elevatedSettings) {
      const postOnboardSetCall = spawnCalls.find(
        (call, index) =>
          index > onboardIndex &&
          call.command === "openclaw" &&
          call.args.includes("config") &&
          call.args.includes("set") &&
          call.args.includes(key) &&
          call.args.includes(value),
      );
      expect(postOnboardSetCall, `expected post-onboard config set for ${key}=${value}`).toBeDefined();
      expect(postOnboardSetCall?.args).toEqual(
        expect.arrayContaining(["--profile", "dench", "config", "set", key, value]),
      );
    }
  });

  it("reapplies elevated commands on repeated bootstrap runs (idempotent safety)", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );
    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const elevatedEnabledCalls = spawnCalls.filter(
      (call) =>
        call.command === "openclaw" &&
        call.args.includes("config") &&
        call.args.includes("set") &&
        call.args.includes("tools.elevated.enabled"),
    );

    expect(elevatedEnabledCalls).toHaveLength(2);
    for (const call of elevatedEnabledCalls) {
      expect(call.args).toEqual(
        expect.arrayContaining(["--profile", "dench", "config", "set", "tools.elevated.enabled", "true"]),
      );
    }
  });

  it("preserves exec and elevated config in final openclaw.json after full bootstrap cycle", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const configPath = path.join(stateDir, "openclaw.json");
    const finalConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(finalConfig.tools?.exec?.security).toBe("full");
    expect(finalConfig.tools?.exec?.ask).toBe("off");
    expect(finalConfig.tools?.elevated?.enabled).toBe(true);
    expect(finalConfig.tools?.elevated?.allowFrom?.webchat).toEqual(["*"]);
    expect(finalConfig.agents?.defaults?.elevatedDefault).toBe("on");
    expect(finalConfig.commands?.bash).toBe(true);
    expect(finalConfig.commands?.config).toBe(true);
    expect(finalConfig.agents?.defaults?.timeoutSeconds).toBe(86400);
    expect(finalConfig.tools?.profile).toBe("full");
  });

  it("strips npm_config_* env vars from npm global commands (prevents npx prefix hijack)", async () => {
    process.env.npm_config_prefix = "/tmp/npx-fake-prefix";
    process.env.npm_config_global_prefix = "/tmp/npx-fake-global";
    process.env.npm_package_name = "denchclaw";
    process.env.npm_lifecycle_event = "npx";

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await bootstrapCommand(
      {
        nonInteractive: true,
        noOpen: true,
        skipUpdate: true,
      },
      runtime,
    );

    const npmGlobalCalls = spawnCalls.filter(
      (call) =>
        call.command === "npm" &&
        (call.args.includes("-g") || call.args.includes("--global")),
    );

    expect(npmGlobalCalls.length).toBeGreaterThan(0);
    for (const call of npmGlobalCalls) {
      const env = call.options?.env;
      expect(env).toBeDefined();
      if (env) {
        const leakedKeys = Object.keys(env).filter(
          (key) =>
            key.startsWith("npm_config_") ||
            key.startsWith("npm_package_") ||
            key === "npm_lifecycle_event" ||
            key === "npm_lifecycle_script",
        );
        expect(leakedKeys).toEqual([]);
      }
    }
  });
});

describe("buildBootstrapDiagnostics", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = createTempStateDir();
    writeBootstrapFixtures(stateDir);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function buildDiagnostics(params?: {
    denchCloudEnabled?: boolean;
    composioConfigured?: boolean;
  }) {
    return buildBootstrapDiagnostics({
      profile: "dench",
      openClawCliAvailable: true,
      openClawVersion: "OpenClaw 2026.3.31",
      gatewayPort: 19001,
      gatewayUrl: "http://127.0.0.1:19001",
      gatewayProbe: { ok: true },
      denchCloudEnabled: params?.denchCloudEnabled ?? true,
      composioConfigured: params?.composioConfigured ?? true,
      webPort: 3100,
      webReachable: true,
      rolloutStage: "default",
      legacyFallbackEnabled: false,
      stateDir,
      env: process.env,
    });
  }

  it("reports Composio as configured when Dench Cloud is enabled", () => {
    const diagnostics = buildDiagnostics();
    const check = diagnostics.checks.find((entry) => entry.id === "composio");
    expect(check).toMatchObject({
      id: "composio",
      status: "pass",
      detail: "Composio MCP configured via Dench Cloud gateway.",
    });
  });

  it("warns when Dench Cloud is enabled but Composio is not configured", () => {
    const diagnostics = buildDiagnostics({ composioConfigured: false });
    const check = diagnostics.checks.find((entry) => entry.id === "composio");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("Composio MCP not configured");
    expect(check?.remediation).toContain("Settings > Integrations");
  });

  it("omits the Composio check when Dench Cloud is disabled", () => {
    const diagnostics = buildDiagnostics({ denchCloudEnabled: false, composioConfigured: false });
    expect(diagnostics.checks.some((entry) => entry.id === "composio")).toBe(false);
  });
});
