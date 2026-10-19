import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  configureExecutionIdentityAdmissionSink,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { formatCliFailureLines, formatCliJsonFailure } from "../cli/failure-output.js";
import type { OpenClawConfig } from "../config/config.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import {
  createExplicitSystemAgentConfig,
  createGatewayNormalCloseError,
  createGatewayTimeoutError,
  createLocalGatewayLockOptions,
  createSignalProcess,
  settleGatewayAgentRequest,
} from "./agent-via-gateway.test-support.js";
import type { agentCommand as AgentCommand } from "./agent.js";

const loadConfig = vi.hoisted(() => vi.fn());
const loadConfigWithShellEnvFallback = vi.hoisted(() => vi.fn());
const loadRuntimeConfig = vi.hoisted(() => vi.fn());
const callGateway = vi.hoisted(() => vi.fn());
const agentCommand = vi.hoisted(() => vi.fn());
const agentModuleLoadCount = vi.hoisted(() => vi.fn());
const loadAgentSessionModuleMock = vi.hoisted(() => vi.fn());
const startOneShotDiagnosticsExporters = vi.hoisted(() => vi.fn());
const auditRecorderMocks = vi.hoisted(() => ({
  create: vi.fn(),
  recordExecutionIdentity: vi.fn(() => true),
  stop: vi.fn(async () => {}),
}));

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}
const runtime: RuntimeEnv = createRuntime();
const jsonRuntime = { ...createRuntime(), writeJson: vi.fn(), writeStdout: vi.fn() };

function mockConfig(storePath: string, overrides?: Partial<OpenClawConfig>) {
  const config = {
    agents: {
      defaults: {
        timeoutSeconds: 600,
        ...overrides?.agents?.defaults,
      },
      ...(overrides?.agents?.ownership ? { ownership: overrides.agents.ownership } : {}),
      ...(overrides?.agents?.entries ? { entries: overrides.agents.entries } : {}),
    },
    session: {
      store: storePath,
      mainKey: "main",
      ...overrides?.session,
    },
    gateway: overrides?.gateway,
    logging: overrides?.logging,
  };
  loadConfig.mockReturnValue(config);
  loadConfigWithShellEnvFallback.mockResolvedValue(config);
  loadRuntimeConfig.mockReturnValue(config);
}

function createTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-cli-"));
  const store = path.join(dir, "sessions.json");
  mockConfig(store);
  return { dir, store };
}
let testStore: ReturnType<typeof createTempStore>;

type CommandOptions = Parameters<typeof agentCliCommand>[0];
type CommandDeps = Parameters<typeof agentCliCommand>[2];
function runText(options: CommandOptions, deps?: CommandDeps, output = runtime) {
  return agentCliCommand({ message: "hi", ...options }, output, deps);
}
function runTo(deps?: CommandDeps, options: CommandOptions = {}) {
  return runText({ to: "+1555", ...options }, deps);
}
function runJson(options: CommandOptions, deps?: CommandDeps) {
  return runText(options, deps, jsonRuntime);
}
function runSignalled(
  signals: ReturnType<typeof createSignalProcess>,
  options: CommandOptions = {},
  deps?: CommandDeps,
  output = runtime,
) {
  return runText({ to: "+1555", ...options }, { process: signals.processLike, ...deps }, output);
}
function runMessageFile(messageFile: string) {
  return agentCliCommand({ messageFile, sessionKey: "agent:main:incident-42" }, runtime);
}

function gatewaySuccessReply(text: string) {
  return {
    runId: "idem-1",
    status: "ok",
    result: { payloads: [{ text }], meta: { stub: true } },
  };
}

function mockGatewaySuccessReply(text = "hello") {
  callGateway.mockResolvedValue(gatewaySuccessReply(text));
}

function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectCliError(error: Error, provenance = {}) {
  expect(formatCliJsonFailure(error, { env: {} })).toEqual({
    ok: false,
    error: { type: "cli_error", message: error.message },
    ...provenance,
  });
}

function mockRemoteGatewayRoster(ownership: "sole" | "legacy" | "explicit", agents = ["ops"]) {
  callGateway.mockImplementation(async (requestValue) => {
    const request = requireRecord(requestValue, "gateway request");
    return request.method === "agents.list"
      ? {
          defaultId: "ops",
          ownership,
          selectionRequired: ownership === "explicit",
          mainKey: "remote-main",
          scope: "per-sender",
          agents: agents.map((id) => ({ id })),
        }
      : gatewaySuccessReply("remote");
  });
}

const remoteGatewayConfig = {
  gateway: { mode: "remote" as const, remote: { url: "wss://gateway.example" } },
};

function localResult(text = "local") {
  return {
    payloads: [{ text }],
    meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
  } as unknown as Awaited<ReturnType<typeof AgentCommand>>;
}

function mockLocalAgentReply(text = "local") {
  agentCommand.mockImplementationOnce(async (_opts, rt) => {
    rt?.log?.(text);
    return localResult(text);
  });
}

const requireRecord = createRequireRecord("record", "expected-label-object-short");

function gatewayRequest(index = 0) {
  return requireRecord(callGateway.mock.calls[index]?.[0], "gateway request");
}

function gatewayParams(index = 0) {
  return requireRecord(gatewayRequest(index).params, "gateway request params");
}

const backendAuthority = {
  clientName: "gateway-client",
  mode: "backend",
  scopes: ["operator.admin"],
};

function mockAbortableAgent(
  handleAgent: (request: Record<string, unknown>) => Promise<unknown>,
  handleFallback?: (request: Record<string, unknown>) => unknown,
) {
  callGateway.mockImplementation(async (value: unknown) => {
    const request = requireRecord(value, "gateway request");
    if (request.method === "agent") {
      return handleAgent(request);
    }
    if (request.method === "chat.abort" && handleFallback) {
      return handleFallback(request);
    }
    throw new Error(`unexpected gateway method ${String(request.method)}`);
  });
}

function expectNoSignalListeners(signals: ReturnType<typeof createSignalProcess>) {
  expect([signals.listenerCount("SIGTERM"), signals.listenerCount("SIGINT")]).toEqual([0, 0]);
}

function rejectOnGatewayAbort(signal: AbortSignal | undefined, onAbort?: () => Promise<void>) {
  return new Promise<never>((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        void (async () => {
          await onAbort?.();
          reject(Object.assign(new Error("gateway request aborted"), { name: "AbortError" }));
        })();
      },
      { once: true },
    );
  });
}

type GatewaySignalAbort = (
  request: (method: string, params?: unknown, opts?: GatewayAbortCall["opts"]) => Promise<unknown>,
) => Promise<void>;

type GatewayAbortCall = {
  method: string;
  params: unknown;
  opts?: { timeoutMs?: number | null };
};

async function waitForAgentCommandCall(expectedCalls = 1) {
  await vi.waitFor(() => expect(agentCommand).toHaveBeenCalledTimes(expectedCalls));
}

async function waitForGatewayCall(expectedCalls = 1) {
  await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(expectedCalls));
}

async function expectGatewayFailure(error: Error, runId?: string) {
  const signal = createSignalProcess();
  const humanBefore = formatCliFailureLines({ title: "failed", error, env: {} });
  await expect(
    runJson(
      { sessionKey: "agent:ops:run-proof", runId: "local-idempotency", json: true },
      { process: signal.processLike },
    ),
  ).rejects.toBe(error);
  expectCliError(error, runId ? { runId, origin: "gateway" } : {});
  expect(formatCliFailureLines({ title: "failed", error, env: {} })).toEqual(humanBefore);
  expect(callGateway).toHaveBeenCalledOnce();
  expect(agentCommand).not.toHaveBeenCalled();
  expect(signal.listenerCount("SIGINT") + signal.listenerCount("SIGTERM")).toBe(0);
}

function mockMessages(mock: unknown): string[] {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  return calls.map(([message]) => String(message));
}

vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: loadConfig,
  readGatewayDispatchConfigWithShellEnvFallback: loadConfigWithShellEnvFallback,
}));
// mock-isolation: Gateway dispatch fixtures control runtime config without loading operator state.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: loadRuntimeConfig,
  captureRuntimeConfigAsyncReader: () => async () => loadRuntimeConfig(),
  loadConfig: loadRuntimeConfig,
}));
// mock-isolation: exercise dispatch without opening a live Gateway connection.
vi.mock("../gateway/call.js", () => ({
  callGateway,
  isGatewayCredentialsRequiredError: (value: unknown) =>
    value instanceof Error && value.name === "GatewayCredentialsRequiredError",
  isGatewayExplicitAuthRequiredError: (value: unknown) =>
    value instanceof Error && value.name === "GatewayExplicitAuthRequiredError",
  isGatewayTransportError(value: unknown) {
    if (!(value instanceof Error) || value.name !== "GatewayTransportError") {
      return false;
    }
    const kind = (value as { kind?: unknown }).kind;
    return kind === "closed" || kind === "timeout";
  },
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => {
  agentModuleLoadCount();
  return { agentCommand };
});
vi.mock("../plugins/one-shot-diagnostics.js", () => ({
  startOneShotDiagnosticsExporters,
}));
vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: (...args: unknown[]) => {
    auditRecorderMocks.create(...args);
    return {
      recordExecutionIdentity: auditRecorderMocks.recordExecutionIdentity,
      stop: auditRecorderMocks.stop,
    };
  },
}));

let originalForceConsoleToStderr = false;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks preserves rejecting exporter implementations across --local tests.
  startOneShotDiagnosticsExporters.mockReset();
  startOneShotDiagnosticsExporters.mockResolvedValue(null);
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
  // A fresh mock generation detects imports even after the real module was warmed.
  vi.doMock("./agent/session.runtime.js", async (importOriginal) => {
    loadAgentSessionModuleMock();
    return await importOriginal<typeof import("./agent/session.runtime.js")>();
  });
  originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
  testStore = createTempStore();
});

afterEach(() => {
  fs.rmSync(testStore.dir, { recursive: true, force: true });
  vi.doUnmock("./agent/session.runtime.js");
  vi.unstubAllEnvs();
  configureExecutionIdentityAdmissionSink(() => false)();
  vi.useRealTimers();
  loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
});

it("rejects blank --to selectors before local or Gateway dispatch", async () => {
  mockGatewaySuccessReply();
  for (const local of [false, true]) {
    for (const value of ["", "   "]) {
      await expect(runText({ local, to: value })).rejects.toThrow("--to must not be blank");
    }
  }
  expectUncalled(callGateway, agentCommand);
});

it.each([
  { message: "hi", clientName: "cli", mode: "cli" },
  { message: "/reset check status", clientName: "gateway-client", mode: "backend" },
])(
  "uses $mode authority with the local gateway for $message",
  async ({ message, clientName, mode }) => {
    mockConfig(testStore.store, { agents: { ownership: "explicit", entries: { solo: {} } } });
    const thinkingClamp =
      "Thinking level clamped to off for ollama/llama3.2 (requested high; preference retained).";
    callGateway.mockResolvedValue({
      ...gatewaySuccessReply("hello"),
      result: {
        payloads: [{ text: "hello" }],
        meta: { requestShaping: { thinking: "off", thinkingClamp } },
      },
    });

    await agentCliCommand({ message, to: "+1555", timeout: "20" }, runtime);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const request = gatewayRequest();
    expect(request).toMatchObject({
      clientName,
      mode,
      scopes: ["operator.admin"],
      timeoutMs: null,
      params: { message, agentId: "solo", timeout: 20 },
    });
    expect(request.params).not.toHaveProperty("cleanupBundleMcpOnRunEnd");
    expectUncalled(agentCommand, agentModuleLoadCount);
    expect(runtime.log).toHaveBeenCalledWith("hello");
    expect(runtime.log).toHaveBeenCalledWith(thinkingClamp);
    expectUncalled(startOneShotDiagnosticsExporters, loadRuntimeConfig);
  },
);

it("keeps ordinary gateway URL override runs least-privilege", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway-override.example");
  mockRemoteGatewayRoster("sole");

  await runTo();

  expect(callGateway).toHaveBeenCalledTimes(2);
  const request = gatewayRequest(1);
  expect(request).toMatchObject({ clientName: "cli", mode: "cli" });
  expect(request).not.toHaveProperty("scopes");
});

it("uses the explicit remote selection and session-id contract", async () => {
  mockConfig(testStore.store, remoteGatewayConfig);
  mockRemoteGatewayRoster("explicit", ["ops", "research"]);
  await expect(runText({})).rejects.toMatchObject({
    code: "AGENT_SELECTION_REQUIRED",
    agentIds: ["ops", "research"],
  });
  expect(callGateway).toHaveBeenCalledOnce();

  mockRemoteGatewayRoster("explicit", ["ops", "research"]);
  await runText({ sessionId: "remote-session" });
  const request = requireRecord(callGateway.mock.calls.at(-1)?.[0], "agent request");
  expect(request.params).toMatchObject({
    agentId: undefined,
    sessionId: "remote-session",
    sessionKey: undefined,
  });
  expect(loadAgentSessionModuleMock).not.toHaveBeenCalled();
});

it("forwards a remote bare key unchanged with an explicit agent", async () => {
  mockConfig(testStore.store, remoteGatewayConfig);
  await runText({ agent: "ops", sessionKey: "incident-42" });

  expect(gatewayParams()).toMatchObject({ agentId: "ops", sessionKey: "incident-42" });
  expect(loadAgentSessionModuleMock).not.toHaveBeenCalled();
});

it.each([
  ["retained-owner scoped main", "work", "per-sender", "agent:ops:work"],
  ["retained-owner global", "main", "global", undefined],
  ["persisted fixed-store global", "main", "global", "global"],
] as const)(
  "dispatches a bare turn to the %s session",
  async (name, mainKey, scope, sessionKey) => {
    const agents = {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    };
    const config =
      name === "persisted fixed-store global"
        ? { agents, session: { scope } }
        : createCanonicalAgentConfigFixture({
            agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
            session: { mainKey, scope },
          }).config;
    mockConfig(testStore.store, config);
    mockGatewaySuccessReply();
    await runText({});
    expect(gatewayRequest().params).toMatchObject({ agentId: undefined, sessionKey });
  },
);

it("keeps an ownerless explicit global session fail-closed through --local", async () => {
  mockConfig(testStore.store, {
    agents: { entries: { ops: {}, research: {} } },
    session: { scope: "global" },
  });
  const runtimeConfig = loadRuntimeConfig();
  loadRuntimeConfig.mockReturnValue({
    ...runtimeConfig,
    agents: { ...runtimeConfig.agents, ownership: "explicit" },
  });

  await expect(runText({ local: true, sessionKey: "global" })).rejects.toMatchObject({
    code: "AGENT_SELECTION_REQUIRED",
  });
  expect(agentCommand).not.toHaveBeenCalled();
});

it.each([false, true])("reads a UTF-8 message file (symlink chain=%s)", async (symlinks) => {
  const { dir } = testStore;
  const messageFile = path.join(dir, "task.md");
  const messageBody = 'first line\n```json\n{"ok":true}\n```\nsecond line\n';
  fs.writeFileSync(messageFile, `\uFEFF${messageBody}`, "utf8");
  let inputFile = messageFile;
  if (symlinks) {
    for (const name of ["link-a.md", "link-b.md", "link-c.md"]) {
      const link = path.join(dir, name);
      fs.symlinkSync(inputFile, link);
      inputFile = link;
    }
  }
  mockGatewaySuccessReply();

  await runMessageFile(inputFile);

  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(gatewayParams()).toMatchObject({
    message: messageBody,
    sessionKey: "agent:main:incident-42",
    sessionId: undefined,
    to: undefined,
  });
  expect(gatewayRequest().config).toBe(loadConfig.mock.results[0]?.value);
  expect(loadConfig).toHaveBeenCalledWith();
  expectUncalled(agentCommand, loadAgentSessionModuleMock);
});

it("refuses --local before embedded startup when a live Gateway owns the state directory", async () => {
  const lockOptions = createLocalGatewayLockOptions(testStore.dir, {
    readProcessStartTime: () => 123_456,
  });
  const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
  expect(gatewayLock).not.toBeNull();
  if (!gatewayLock) {
    throw new Error("Expected live Gateway fixture lock");
  }

  try {
    await expect(
      runJson({ to: "+1555", local: true, json: true }, { localGatewayLockOptions: lockOptions }),
    ).rejects.toThrow(
      `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Run without --local to use it, or stop the Gateway first (openclaw gateway stop).`,
    );
    expectUncalled(agentCommand, startOneShotDiagnosticsExporters, jsonRuntime.writeJson);
  } finally {
    await gatewayLock.release();
  }
});

it("holds one agent-embedded state lock for the run and rejects a concurrent --local run", async () => {
  const { dir } = testStore;
  let elapsedMs = 0;
  const lockOptions = createLocalGatewayLockOptions(dir, {
    now: () => elapsedMs,
    sleep: async (ms) => {
      elapsedMs += ms;
    },
  });
  const firstRunStarted = createDeferredCore();
  const firstRunFinished = createDeferredCore();
  agentCommand.mockImplementationOnce(async () => {
    firstRunStarted.resolve();
    await firstRunFinished.promise;
  });
  const firstRun = runTo(
    {
      localGatewayLockOptions: lockOptions,
    },
    { message: "first", local: true },
  );
  const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
  try {
    await Promise.race([firstRunStarted.promise, firstRun]);
    const payload: unknown = JSON.parse(fs.readFileSync(stateLockPath, "utf8"));
    expect(payload).toMatchObject({ pid: process.pid, role: "agent-embedded" });

    const secondRun = runTo(
      {
        localGatewayLockOptions: lockOptions,
      },
      { message: "second", local: true },
    );
    await expect(secondRun).rejects.toBeInstanceOf(GatewayLockError);
    await expect(secondRun).rejects.toMatchObject({
      message: expect.stringContaining("wait for the current OpenClaw operation to finish"),
      cause: expect.any(GatewayStateOwnerContentionError),
    });
    await expect(secondRun).rejects.toMatchObject({
      message: expect.stringContaining(path.join(fs.realpathSync(dir), "state", "openclaw.sqlite")),
      cause: {
        databasePath: path.join(fs.realpathSync(dir), "state", "openclaw.sqlite"),
      },
    });
    expect(agentCommand).toHaveBeenCalledTimes(1);
  } finally {
    firstRunFinished.resolve();
    await firstRun;
  }
  expect(fs.existsSync(stateLockPath)).toBe(false);
});

it.each([
  ["missing", "Message file not found"],
  ["invalid UTF-8", "Message file must be valid UTF-8"],
  ["oversized", "File exceeds 4194304 bytes"],
  ["directory", "Message file is a directory:"],
])("rejects a %s message file before dispatch", async (kind, error) => {
  const { dir } = testStore;
  const messageFile = path.join(dir, "message");
  if (kind === "invalid UTF-8") {
    fs.writeFileSync(messageFile, Buffer.from([0xff]));
  } else if (kind === "oversized") {
    fs.writeFileSync(messageFile, Buffer.alloc(5 * 1024 * 1024, "x"));
  } else if (kind === "directory") {
    fs.mkdirSync(messageFile);
  }
  await expect(runMessageFile(messageFile)).rejects.toThrow(error);
  expect(callGateway).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "linux")(
  "reads a procfs file-descriptor link without resolving it to a pathname",
  async () => {
    const { dir } = testStore;
    const realFile = path.join(dir, "procfs-source.md");
    fs.writeFileSync(realFile, "hello from procfs descriptor", "utf-8");
    const sourceHandle = await fs.promises.open(realFile, "r");
    fs.unlinkSync(realFile);
    try {
      await runMessageFile(`/proc/self/fd/${sourceHandle.fd}`);
    } finally {
      await sourceHandle.close();
    }

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(gatewayParams().message).toBe("hello from procfs descriptor");
  },
);

// FIFOs have no stat-able size; drain until EOF. Windows lacks mkfifo.
it.skipIf(process.platform === "win32")("reads a FIFO message file until EOF", async () => {
  const { dir } = testStore;
  const messageFile = path.join(dir, "pipe.md");
  execFileSync("mkfifo", [messageFile]);
  mockGatewaySuccessReply();

  const dispatch = runMessageFile(messageFile);
  // Dispatch blocks on a writer; closing it supplies EOF to the bounded read.
  const writer = (async () => {
    const handle = await fs.promises.open(messageFile, "w");
    try {
      await handle.writeFile("hello from fifo");
    } finally {
      await handle.close();
    }
  })();
  await dispatch;
  await writer;

  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(gatewayParams().message).toBe("hello from fifo");
});

it("uses an agent-scoped --to value as the gateway session selector", async () => {
  const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
  mockGatewaySuccessReply();

  await runText({ to: sessionKey });

  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(gatewayParams()).toMatchObject({ sessionKey, to: undefined });
  expectUncalled(agentCommand, loadAgentSessionModuleMock);
});

it("retries gateway dispatch with shell env fallback for env URL auth", async () => {
  const fastConfig = loadConfig();
  loadConfig.mockReset();
  loadConfig.mockReturnValueOnce(fastConfig);
  loadConfigWithShellEnvFallback.mockReset();
  loadConfigWithShellEnvFallback.mockResolvedValueOnce(fastConfig);
  const authError = new Error("gateway url override requires explicit credentials");
  authError.name = "GatewayExplicitAuthRequiredError";
  callGateway.mockRejectedValueOnce(authError);
  mockGatewaySuccessReply();

  await runText({ sessionKey: "agent:main:incident-42" });

  expect(loadConfig).toHaveBeenCalledTimes(1);
  expect(loadConfig).toHaveBeenCalledWith();
  expect(loadConfigWithShellEnvFallback).toHaveBeenCalledTimes(1);
  expect(loadConfigWithShellEnvFallback).toHaveBeenCalledWith();
  expect(callGateway).toHaveBeenCalledTimes(2);
});

it.each([
  ["incident-42", "agent:ops:incident-42"],
  ["unknown", "unknown"],
])("normalizes the implicit-owner session key %s to %s", async (sessionKey, expected) => {
  mockConfig(testStore.store, createExplicitSystemAgentConfig("ops", ["ops", "main"]));
  mockGatewaySuccessReply();

  await runText({ sessionKey });

  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(gatewayParams()).toMatchObject({ agentId: undefined, sessionKey: expected });
});

it("exits for successful gateway runs when SIGTERM arrives before return", async () => {
  const signals = createSignalProcess();
  mockGatewaySuccessReply();
  const signalRuntime = { ...createRuntime(), log: vi.fn(() => signals.emit("SIGTERM")) };

  const result = await runSignalled(signals, {}, undefined, signalRuntime);

  expect(result).toBeUndefined();
  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(agentCommand).not.toHaveBeenCalled();
  expect(signalRuntime.log).toHaveBeenCalledWith("hello");
  expect(signalRuntime.exit).toHaveBeenCalledWith(143);
});

it.each([
  ["accepted", "run-signal", "agent:main:explicit:reset-run"],
  ["recipient", "recipient-pre-accepted-run", "agent:ops:main"],
  ["not-started", "", ""],
  ["retry", "pre-accepted-run", "agent:main:main"],
  ["fallback", "pre-accepted-run", "agent:main:main"],
  ["model-fallback", "run-model-fallback", "agent:main:main"],
])("settles SIGTERM for %s gateway routing", async (mode, runId, sessionKey) => {
  const accepted = mode === "accepted",
    recipient = mode === "recipient";
  const retry = ["retry", "fallback", "model-fallback"].includes(mode);
  const fallback = mode.endsWith("fallback");
  const model = mode === "model-fallback" ? "ollama/qwen3.5:9b" : undefined;
  if (recipient) {
    mockConfig(testStore.store, {
      agents: { entries: { main: {}, ops: {} } },
      session: { dmScope: "per-channel-peer" },
    });
  }
  const signals = createSignalProcess(),
    started = createDeferredCore();
  const aborts: GatewayAbortCall[] = [];
  let fallbackAbort: Record<string, unknown> | undefined;
  mockAbortableAgent(
    async (request) => {
      const signal = request.signal as AbortSignal | undefined;
      if (mode === "not-started") {
        return rejectOnGatewayAbort(signal);
      }
      const params = requireRecord(request.params, "gateway agent params");
      if (recipient) {
        expect(params).toMatchObject({
          agentId: "ops",
          channel: "whatsapp",
          to: "+15551234567",
          idempotencyKey: runId,
        });
        expect(params.sessionKey).toBeUndefined();
      } else if (retry) {
        expect(params.idempotencyKey).toBe(model ? "idem-1" : runId);
      }
      if (model) {
        expect(request).toMatchObject(backendAuthority);
      }
      if (accepted || model) {
        const onAccepted = request.onAccepted as ((payload: unknown) => void) | undefined;
        onAccepted?.({
          status: "accepted",
          runId,
          ...(accepted ? { sessionKey, agentId: "main" } : {}),
        });
      }
      const onSignalAbort = request.onSignalAbort as GatewaySignalAbort | undefined;
      started.resolve();
      return rejectOnGatewayAbort(signal, async () => {
        await onSignalAbort?.(async (method, abortParams, opts) => {
          aborts.push({ method, params: abortParams, opts });
          const aborted = !retry || (!fallback && aborts.length >= 3);
          return { ok: true, aborted, runIds: aborted ? [runId] : [] };
        });
      });
    },
    fallback
      ? (request) => {
          fallbackAbort = request;
          return { ok: true, aborted: true, runIds: [runId] };
        }
      : undefined,
  );
  const run = runSignalled(
    signals,
    recipient
      ? { agent: "ops", channel: "whatsapp", to: "+15551234567", runId }
      : retry
        ? { runId: model ? undefined : runId, model }
        : {},
  );
  if (retry) {
    await Promise.race([run, started.promise]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
  } else {
    await waitForGatewayCall();
  }
  signals.emit("SIGTERM");
  if (accepted) {
    expectNoSignalListeners(signals);
  }
  if (retry) {
    await vi.runAllTimersAsync();
  }
  await run;
  expect(runtime.exit).toHaveBeenCalledWith(143);
  if (!recipient) {
    expect(callGateway).toHaveBeenCalledTimes(fallback ? 2 : 1);
  }
  if (mode === "not-started") {
    expectNoSignalListeners(signals);
    return;
  }
  const lastAbort = aborts.at(-1);
  if (retry) {
    expect(aborts).toHaveLength(fallback ? 5 : 3);
    expect(lastAbort).toEqual({
      method: "chat.abort",
      opts: { timeoutMs: 2_000 },
      params: { sessionKey, runId },
    });
    expectNoSignalListeners(signals);
  } else {
    expect(lastAbort?.method).toBe("chat.abort");
    expect(lastAbort?.params).toEqual({
      sessionKey,
      runId,
      ...(accepted ? { agentId: "main" } : {}),
    });
    if (accepted) {
      expect(lastAbort?.opts).toEqual({ timeoutMs: 2_000 });
    }
  }
  if (fallback) {
    expect(fallbackAbort).toMatchObject({ method: "chat.abort", timeoutMs: 2_000 });
    expect(fallbackAbort?.params).toEqual({ sessionKey, runId });
    expect(fallbackAbort?.config).toBe(loadConfig.mock.results[0]?.value);
    if (model) {
      expect(fallbackAbort).toMatchObject(backendAuthority);
    }
  }
});

it.each([
  { signal: "SIGTERM", exitCode: 143, outcome: "reject" },
  { signal: "SIGINT", exitCode: 130, outcome: "failed" },
] as const)(
  "releases local state after $signal ($outcome)",
  async ({ signal, exitCode, outcome }) => {
    const { dir } = testStore;
    const signals = createSignalProcess();
    const lockOptions = createLocalGatewayLockOptions(dir);
    agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
      expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
      return await new Promise((resolve, reject) => {
        opts.abortSignal?.addEventListener(
          "abort",
          () => {
            if (outcome === "failed") {
              resolve(
                recordAgentRunTerminalOutcome(
                  { payloads: [], meta: { aborted: true } },
                  "failed",
                ) as unknown as Awaited<ReturnType<typeof AgentCommand>>,
              );
              return;
            }
            const err = new Error("local agent aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    });

    const run = runSignalled(signals, { local: true }, { localGatewayLockOptions: lockOptions });
    await waitForAgentCommandCall();
    const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
    expect(fs.existsSync(stateLockPath)).toBe(true);
    signals.emit(signal);

    await expect(run).resolves.toBeUndefined();
    expect(fs.existsSync(stateLockPath)).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(exitCode);
    expectNoSignalListeners(signals);
  },
);

it("aborts while waiting for a transient gateway retry", async () => {
  vi.useFakeTimers();
  const signals = createSignalProcess();
  callGateway.mockRejectedValueOnce(createGatewayNormalCloseError());

  const run = runSignalled(signals);
  for (let attempt = 0; attempt < 10 && mockMessages(runtime.error).length === 0; attempt += 1) {
    await Promise.resolve();
  }
  signals.emit("SIGTERM");

  await expect(run).resolves.toBeUndefined();
  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(agentCommand).not.toHaveBeenCalled();
  expect(runtime.exit).toHaveBeenCalledWith(143);
});

it.each([
  { json: false, ok: true, withdrawn: false },
  { json: true, ok: false, withdrawn: true },
  { json: false, ok: false, withdrawn: true },
])(
  "renders timeout with json=$json, RPC ok=$ok, withdrawn=$withdrawn",
  async ({ json, ok, withdrawn }) => {
    const signals = createSignalProcess();
    const response = {
      runId: "idem-1",
      status: "timeout",
      summary: withdrawn ? "Input was not delivered. Raise --timeout and retry." : "timeout",
      ...(withdrawn
        ? { reason: "input_withdrawn_before_turn", pendingInputId: "withdrawn-input" }
        : {}),
      result: { payloads: [], meta: { stopReason: "timeout" } },
    };
    callGateway.mockImplementation(() =>
      settleGatewayAgentRequest({
        response: {
          ok,
          payload: response,
          ...(ok ? {} : { error: { code: "UNAVAILABLE", message: "deadline elapsed" } }),
        },
      }),
    );

    await runSignalled(signals, { json }, undefined, jsonRuntime);

    expect(signals.processLike.exitCode).toBe(1);
    expect(jsonRuntime.exit).not.toHaveBeenCalled();
    expect(jsonRuntime.log).toHaveBeenCalledTimes(!json && !withdrawn ? 1 : 0);
    if (json) {
      expect(jsonRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
        { ...response, status: ok ? "timeout" : "cancelled" },
        2,
      );
    } else {
      expect(withdrawn ? jsonRuntime.error : jsonRuntime.log).toHaveBeenCalledWith(
        response.summary,
      );
    }
  },
);

it("surfaces duplicate in-flight gateway runs without pretending a reply arrived", async () => {
  const signals = createSignalProcess();
  callGateway.mockResolvedValue({
    runId: "idem-1",
    status: "in_flight",
    sessionKey: "agent:main:main",
  });

  await runSignalled(signals, { runId: "idem-1" });

  expect(runtime.error).toHaveBeenCalledWith(
    "Agent run idem-1 is already in flight; not starting a duplicate run.",
  );
  expect(runtime.log).not.toHaveBeenCalledWith("No reply from agent.");
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(signals.processLike.exitCode).toBe(1);
});

it("promotes gateway deliveryStatus to the top-level JSON response", async () => {
  const deliveryStatus = {
    requested: true,
    attempted: true,
    status: "sent",
    succeeded: true,
    resultCount: 1,
  };
  const response = gatewaySuccessReply("hello");
  const deliveredResponse = { ...response, result: { ...response.result, deliveryStatus } };
  callGateway.mockImplementationOnce(async () => {
    expect(loggingState.forceConsoleToStderr).toBe(true);
    return deliveredResponse;
  });

  await runJson({ to: "+1555", json: true, deliver: true });

  expect(jsonRuntime.writeJson).toHaveBeenCalledWith(
    {
      ...deliveredResponse,
      deliveryStatus,
    },
    2,
  );
  expect(jsonRuntime.log).not.toHaveBeenCalled();
});

it.each([
  ["accepted negative final", true, "gateway-final", "gateway-final"],
  ["cached final only", false, "gateway-cached", "gateway-cached"],
  ["accepted final without ID", true, undefined, "gateway-accepted"],
  ["non-string final ID", false, 123, undefined],
] as const)(
  "reports only observed Gateway run provenance for %s",
  async (_label, wasAccepted, finalId, runId) => {
    mockConfig(testStore.store, remoteGatewayConfig);
    const payload =
      finalId === undefined
        ? { status: "error" }
        : {
            runId: finalId,
            ...(typeof finalId === "string" ? { privateResult: "not-for-cli" } : {}),
          };
    const error = new GatewayClientRequestError({
      code: "UNAVAILABLE",
      message: "turn failed",
      details: { runId: "not-provenance", privateResult: "not-for-cli" },
      retryable: true,
      retryAfterMs: 250,
    });
    callGateway.mockImplementation((request: { onAccepted?: (payload: unknown) => void }) =>
      settleGatewayAgentRequest({
        accepted: wasAccepted ? { status: "accepted", runId: "gateway-accepted" } : undefined,
        onAccepted: request.onAccepted,
        requestError: error,
        response: {
          ok: false,
          payload,
          error: { code: error.code, message: error.message },
        },
      }),
    );
    await expectGatewayFailure(error, runId);
    expect(error).toMatchObject({
      name: "GatewayClientRequestError",
      code: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: { runId: "not-provenance" },
    });
  },
);

it("preserves error identity and uncertainty for an accepted timeout", async () => {
  mockConfig(testStore.store, remoteGatewayConfig);
  const error = createGatewayTimeoutError();
  const runId = "gateway-accepted";
  callGateway.mockImplementation(async (request: { onAccepted?: (payload: unknown) => void }) => {
    request.onAccepted?.({ status: "accepted", runId });
    throw error;
  });
  await expectGatewayFailure(error, runId);
  const hint = mockMessages(jsonRuntime.error).join("\n");
  expect(hint).toContain("Gateway agent call");
  expect(hint).toContain("may still be running");
  expect(hint).toContain("--local");
  expect(hint).toContain("timed out");
  expect(hint).toContain(`accepted run ${runId}`);
  expect(hint).toContain("--timeout <seconds>");
});

it("does not promote arbitrary thrown object fields into Gateway provenance", async () => {
  mockConfig(testStore.store, remoteGatewayConfig);
  const error = Object.assign(new Error("local failure"), {
    runId: "forged",
    origin: "gateway",
    responsePayload: { runId: "forged" },
    details: { runId: "forged" },
  });
  callGateway.mockRejectedValue(error);
  await expect(runJson({ sessionKey: "agent:ops:run-proof", json: true })).rejects.toBe(error);
  expectCliError(error);
});

it.each([false, true])(
  "owns only the local audit writer it creates (existing sink=%s)",
  async (existingSink) => {
    mockConfig(testStore.store, { logging: { audit: { executionIdentity: true } } });
    const clearSink = existingSink
      ? configureExecutionIdentityAdmissionSink(() => true)
      : undefined;
    try {
      agentCommand.mockImplementationOnce(async () => {
        expect(hasExecutionIdentityAdmissionSink()).toBe(true);
        return localResult();
      });

      await runTo(undefined, { local: true });

      expect(auditRecorderMocks.create).toHaveBeenCalledTimes(existingSink ? 0 : 1);
      expect(auditRecorderMocks.stop).toHaveBeenCalledTimes(existingSink ? 0 : 1);
      expect(hasExecutionIdentityAdmissionSink()).toBe(existingSink);
    } finally {
      clearSink?.();
    }
  },
);

it.each(["success", "run failure", "exporter failure"])(
  "handles local diagnostics: %s",
  async (outcome) => {
    const stop = vi.fn(async () => {});
    const error = Object.assign(new Error("embedded run failed"), { runId: "local-run" });
    if (outcome === "exporter failure") {
      startOneShotDiagnosticsExporters.mockRejectedValue(new Error("exporter start failed"));
    } else {
      startOneShotDiagnosticsExporters.mockResolvedValue({ stop });
    }
    if (outcome === "run failure") {
      agentCommand.mockRejectedValueOnce(error);
    } else {
      mockLocalAgentReply();
    }
    if (outcome === "run failure") {
      await expect(runTo(undefined, { local: true })).rejects.toThrow("embedded run failed");
      expectCliError(error);
      expect(stop).toHaveBeenCalledTimes(1);
      return;
    }
    if (outcome === "exporter failure") {
      await runTo(undefined, { local: true });
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("local");
      expect(
        mockMessages(runtime.error).some((message) =>
          message.includes("diagnostics exporter startup failed"),
        ),
      ).toBe(true);
      return;
    }
    await runJson({ to: "+1555", local: true, json: true });
    expect(callGateway).not.toHaveBeenCalled();
    expect(agentCommand).toHaveBeenCalledTimes(1);
    expect(startOneShotDiagnosticsExporters).toHaveBeenCalledWith(
      expect.objectContaining({ suppressStdoutDiagnosticLogs: true }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(loadRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(auditRecorderMocks.create).not.toHaveBeenCalled();
    expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
      cleanupBundleMcpOnRunEnd: true,
      cleanupCliLiveSessionOnRunEnd: true,
      oneShotCliRun: true,
    });
    const startOrder = expectDefined(
      startOneShotDiagnosticsExporters.mock.invocationCallOrder[0],
      "exporter start",
    );
    const runOrder = expectDefined(agentCommand.mock.invocationCallOrder[0], "embedded agent");
    const stopOrder = expectDefined(stop.mock.invocationCallOrder[0], "exporter stop");
    expect(startOrder).toBeLessThan(runOrder);
    expect(runOrder).toBeLessThan(stopOrder);
  },
);

it.each([false, true])(
  "retains provenance across transient normal closes (accepted=%s)",
  async (accepted) => {
    vi.useFakeTimers();
    const error = createGatewayNormalCloseError();
    const gatewayStarted = createDeferredCore();
    callGateway.mockImplementation(async (request: { onAccepted?: (payload: unknown) => void }) => {
      gatewayStarted.resolve();
      if (accepted && callGateway.mock.calls.length === 1) {
        request.onAccepted?.({ status: "accepted", runId: "gateway-before-retry" });
        throw createGatewayNormalCloseError();
      }
      throw error;
    });

    const command = runText({ sessionKey: "agent:main:retry-provenance" });
    const rejection = expect(command).rejects.toBe(error);
    // Module loading is not driven by fake time; observe dispatch before advancing it.
    await gatewayStarted.promise;
    await vi.advanceTimersByTimeAsync(33_000);
    await rejection;

    expect(callGateway).toHaveBeenCalledTimes(6);
    const idempotencyKeys = callGateway.mock.calls.map(
      ([call]) => (call as { params?: { idempotencyKey?: unknown } }).params?.idempotencyKey,
    );
    expect(new Set(idempotencyKeys).size).toBe(1);
    expectCliError(error, accepted ? { runId: "gateway-before-retry", origin: "gateway" } : {});
    expect(agentCommand).not.toHaveBeenCalled();
    expect(
      mockMessages(runtime.error).filter((message) =>
        message.includes("Gateway agent connection closed during handshake"),
      ),
    ).toHaveLength(5);
    expect(
      mockMessages(runtime.error).some(
        (message) =>
          message.includes("Gateway agent call connection closed") && message.includes("--local"),
      ),
    ).toBe(true);
  },
);

it("maps a failed local terminal outcome to exit 1", async () => {
  const signals = createSignalProcess();
  agentCommand.mockResolvedValueOnce(
    recordAgentRunTerminalOutcome(
      {
        payloads: [{ text: "provider failed", isError: true }],
        meta: { error: new Error("provider failed") },
      },
      "failed",
    ),
  );

  await runSignalled(signals, { local: true });

  expect(signals.processLike.exitCode).toBe(1);
});

it("scopes legacy explicit session keys before local embedded runs", async () => {
  mockLocalAgentReply();

  await runText({
    agent: "ops",
    sessionKey: "incident-42",
    local: true,
  });

  expect(callGateway).not.toHaveBeenCalled();
  expect(agentCommand).toHaveBeenCalledTimes(1);
  expect(agentCommand.mock.calls[0]?.[0]).toMatchObject({
    agentId: "ops",
    sessionKey: "agent:ops:incident-42",
  });
  expect(loadRuntimeConfig).toHaveBeenCalledWith();
});

it.each([
  [
    "malformed agent session key",
    { sessionKey: "agent:main" },
    'Invalid --session-key "agent:main". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.',
  ],
  [
    "mismatched session owner",
    { sessionKey: "agent:main:incident-42", agent: "ops" },
    'Agent id "ops" does not match session key agent "main".',
  ],
  ["partial timeout", { to: "+1555", timeout: "10s" }, "Invalid --timeout"],
  [
    "inline and file messages together",
    { messageFile: "task.md", sessionKey: "agent:main:incident-42" },
    "Use either --message or --message-file, not both",
  ],
] as const)("rejects %s before dispatch", async (_name, options, error) => {
  await expect(runText({ ...options })).rejects.toThrow(error);
  expectUncalled(callGateway, agentCommand);
});

it("does not mistake a /compacting-prefixed message for the /compact control command", async () => {
  mockGatewaySuccessReply();

  await agentCliCommand(
    { message: "/compacting the report, please", to: "+15555550123", timeout: "0" },
    runtime,
  );

  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(runtime.exit).not.toHaveBeenCalledWith(1);
  expect(gatewayRequest().timeoutMs).toBeNull();
});

it("stops dispatch and releases signal listeners when the session module fails to load", async () => {
  const failure = new Error("synthetic session module load failure");
  vi.doMock("./agent/session.runtime.js", () => {
    throw failure;
  });
  const signals = createSignalProcess();
  await expect(runSignalled(signals)).rejects.toMatchObject({ cause: failure });
  expectUncalled(callGateway, agentCommand);
  expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0);
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
