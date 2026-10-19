import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type GatewayFrame,
  assertGatewaySuspendingError,
  assertReadySuspensionResponse,
  assertSuspendedProbes,
  prepareReadySuspension,
  runGatewayNetworkClient,
  runGatewaySuspensionPostRestartClient,
  runGatewaySuspensionPreRestartClient,
} from "../../scripts/e2e/lib/gateway-network/client.mts";
import { readGatewayNetworkClientConnectTimeoutMs } from "../../scripts/e2e/lib/gateway-network/limits.mts";
import { onceFrame } from "../../scripts/e2e/lib/gateway-network/ws-frames.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timeoutKey = "OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS";
const fallbackKey = "OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS";
const suspensionMethods = [
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
];
const clientOptions = { token: "test-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 };
const stalledOptions = {
  ...clientOptions,
  token: "x",
  statePath: "/tmp/unused-gateway-network-state.json",
  timeoutMs: 25,
};
const busyResponse = adminResponse({
  status: "busy",
  retryAfterMs: 250,
  activeCount: 1,
  blockers: ["agent"],
});
function adminResponse(payload: GatewayFrame["payload"]) {
  return { status: 200, body: { ok: true, payload } };
}
function readyPayload(expiresAtMs = Date.now() + 10_000) {
  return { status: "ready", suspensionId: "lease-1", expiresAtMs, activeCount: 0, blockers: [] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function expectDeadlineBudgets(calls: Array<[number]>) {
  expect(calls.length).toBeGreaterThan(0);
  for (const [timeoutMs] of calls) {
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(25);
  }
}

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
  expect(signal).toBeInstanceOf(AbortSignal);
  const requestSignal = signal as AbortSignal;
  return new Promise((_, reject) => {
    const rejectWithReason = () => reject(requestSignal.reason as Error);
    if (requestSignal.aborted) {
      rejectWithReason();
      return;
    }
    requestSignal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

function healthResponse() {
  return {
    ok: true,
    payload: {
      agents: [],
      channelOrder: [],
      channels: {},
      defaultAgentId: "codex",
      durationMs: 3,
      ok: true,
      sessions: { count: 0, path: "/state/sessions", recent: [] },
      ts: Date.now(),
    },
  };
}

function connectResponse(methods: unknown = suspensionMethods) {
  return { ok: true, payload: { features: { methods } } };
}

it("rejects loose client timeout env values instead of parsing prefixes", () => {
  for (const [key, value] of [
    [timeoutKey, "100ms"],
    [fallbackKey, "1e3"],
    [timeoutKey, "0"],
  ] as const) {
    expect(() => readGatewayNetworkClientConnectTimeoutMs({ [key]: value })).toThrow(
      `invalid ${key}: ${value}`,
    );
  }
});

it("prefers the explicit client timeout over the connect-ready fallback", () => {
  expect(
    readGatewayNetworkClientConnectTimeoutMs({
      [timeoutKey]: "5000",
      [fallbackKey]: "1000",
    }),
  ).toBe(5000);
  expect(readGatewayNetworkClientConnectTimeoutMs({ [fallbackKey]: "3000" })).toBe(3000);
});

it("retries busy suspension preparation using the server delay", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce(busyResponse)
    .mockResolvedValueOnce(adminResponse(readyPayload()));
  const delayImpl = vi.fn(async () => undefined);

  await expect(
    prepareReadySuspension(
      { deadline: Date.now() + 5_000, requestId: "request-1", rpc },
      { delayImpl },
    ),
  ).resolves.toMatchObject({ status: "ready", suspensionId: "lease-1" });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenNthCalledWith(1, "gateway.suspend.prepare", {
    requestId: "request-1",
  });
  expect(delayImpl).toHaveBeenCalledWith(250);
});

it("stops busy suspension retries at the client deadline", async () => {
  let nowMs = 1_000;
  const rpc = vi.fn(async () => busyResponse);
  const delayImpl = vi.fn(async (ms: number) => {
    nowMs += ms;
  });

  await expect(
    prepareReadySuspension(
      { deadline: 1_250, requestId: "request-busy", rpc },
      { delayImpl, now: () => nowMs },
    ),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(rpc).toHaveBeenCalledOnce();
  expect(delayImpl).toHaveBeenCalledWith(250);
});

it.each(["pre", "post"] as const)("bounds a stalled %s-restart admin request", async (phase) => {
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  const fetchImpl = vi.fn<typeof fetch>((_input, init) => rejectWhenAborted(init?.signal));
  const options = { ...stalledOptions };
  if (phase === "post") {
    options.statePath = join(tempDirs.make("gateway-post-restart-"), "suspension.json");
    writeFileSync(
      options.statePath,
      JSON.stringify({
        requestId: "gateway-network-restart-contract",
        suspensionId: "lease-before-restart",
        expiresAtMs: Date.now() + 10_000,
      }),
    );
  }
  const run =
    phase === "pre" ? runGatewaySuspensionPreRestartClient : runGatewaySuspensionPostRestartClient;
  await expect(run(options, { fetchImpl })).rejects.toMatchObject({ name: "TimeoutError" });
  expectDeadlineBudgets(timeoutSpy.mock.calls);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("keeps a stalled suspension response body inside the client deadline", async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  let callCount = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    callCount += 1;
    if (callCount === 1) {
      return Response.json({ ok: true, payload: readyPayload() });
    }
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "json").mockImplementation(() => rejectWhenAborted(init?.signal));
    return response;
  });

  await expect(
    runGatewaySuspensionPreRestartClient(stalledOptions, { fetchImpl }),
  ).rejects.toMatchObject({ name: "TimeoutError" });

  expectDeadlineBudgets(timeoutSpy.mock.calls);
  expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const request = fetchImpl.mock.calls[1]?.[0];
  const requestUrl =
    request instanceof Request
      ? request.url
      : request instanceof URL
        ? request.href
        : (request ?? "");
  expect(requestUrl).toContain("/healthz");
});

it("resolves matching frames and ignores unrelated frames", async () => {
  const ws = new EventEmitter();
  const frame = onceFrame(ws, (message) => message?.id === "target", 1000);

  ws.emit("message", JSON.stringify({ id: "noise" }));
  ws.emit("message", JSON.stringify({ id: "target", ok: true }));

  await expect(frame).resolves.toEqual({ id: "target", ok: true });
});

it.each([
  ["timeout", "message", JSON.stringify({ id: "noise" }), "timeout", 10],
  ["socket error", "error", new Error("socket exploded"), "socket exploded", 1000],
  ["invalid JSON", "message", "{nope", undefined, 1000],
] satisfies Array<[string, string, unknown, string | undefined, number]>)(
  "rejects frame waits on %s",
  async (_label, event, data, error, timeoutMs) => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, timeoutMs);
    ws.emit(event, data);
    await expect(frame).rejects.toThrow(error);
  },
);

it("rejects frame waits immediately when the socket closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const ws = new EventEmitter();
    const rejected = vi.fn();
    const frame = onceFrame(ws, () => false, 1000).catch(rejected);
    expect(vi.getTimerCount()).toBe(1);

    ws.emit("close", 1006, Buffer.from("bye"));
    await vi.advanceTimersByTimeAsync(0);

    expect(rejected).toHaveBeenCalledExactlyOnceWith(new Error("closed before frame: 1006 bye"));
    expect(ws.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await frame;
  } finally {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});

function createNetworkClientHarness(responses: GatewayFrame[]) {
  const frames = [...responses];
  const sentMethods: string[] = [];
  const stdout: string[] = [];
  const close = vi.fn();
  const socket = {
    close,
    send: (payload: string) => {
      sentMethods.push(JSON.parse(payload).method);
    },
  };

  return {
    close,
    sentMethods,
    stdout,
    deps: {
      delay: async () => {},
      onceFrame: async (
        _ws: unknown,
        predicate: (frame: GatewayFrame) => boolean,
        _timeoutMs?: number,
      ) => {
        const response = frames.shift();
        const frame = {
          type: "res",
          id: sentMethods.at(-1) === "connect" ? "c1" : "h1",
          ...(sentMethods.at(-1) === "connect" && response?.ok && !response.payload
            ? connectResponse()
            : response),
        };
        expect(predicate(frame)).toBe(true);
        return frame;
      },
      openSocket: async () => socket,
      protocolVersion: 1,
      stdout: (message: string) => {
        stdout.push(message);
      },
    },
  };
}

it.each([
  ["supported", suspensionMethods],
  ["unsupported", ["health", "status"]],
] as const)(
  "records %s suspension support from connect hello methods",
  async (expected, methods) => {
    const workDir = tempDirs.make("openclaw-gateway-network-capabilities-");
    const capabilitiesPath = join(workDir, "capabilities.json");
    const harness = createNetworkClientHarness([connectResponse(methods), healthResponse()]);

    await expect(
      runGatewayNetworkClient({ ...clientOptions, capabilitiesPath }, harness.deps),
    ).resolves.toEqual({ suspension: expected });
    expect(JSON.parse(readFileSync(capabilitiesPath, "utf8"))).toEqual({
      suspension: expected,
    });
    expect(harness.sentMethods).toEqual(["connect", "health"]);
  },
);

it.each([
  ["partial", ["gateway.suspend.prepare", "gateway.suspend.status"]],
  ["malformed", "gateway.suspend.prepare"],
])("rejects %s suspension methods only after baseline health", async (_label, methods) => {
  const harness = createNetworkClientHarness([connectResponse(methods), healthResponse()]);

  await expect(runGatewayNetworkClient(clientOptions, harness.deps)).rejects.toThrow(
    /suspension methods/u,
  );
  expect(harness.sentMethods).toEqual(["connect", "health"]);
});

it("does not sleep past the remaining client deadline between retries", async () => {
  const delays: number[] = [];
  let now = 1_000;

  vi.spyOn(Date, "now").mockImplementation(() => now);
  await expect(
    runGatewayNetworkClient(
      { ...clientOptions, timeoutMs: 250 },
      {
        delay: async (ms: number) => {
          delays.push(ms);
          now += ms;
        },
        openSocket: async () => {
          now += 200;
          throw new Error("ECONNREFUSED");
        },
        protocolVersion: 1,
        stdout: () => {},
      },
    ),
  ).rejects.toThrow("ECONNREFUSED");

  expect(delays).toEqual([50]);
});

it.each([
  [{ ok: true }, "missing health summary payload"],
  [{ ok: false, error: { message: "health unavailable" } }, "health unavailable"],
] satisfies Array<[GatewayFrame, string]>)(
  "rejects health response %j",
  async (response, error) => {
    const harness = createNetworkClientHarness([{ ok: true }, response]);
    await expect(runGatewayNetworkClient(clientOptions, harness.deps)).rejects.toThrow(
      `health failed: ${error}`,
    );
    expect(harness).toMatchObject({
      sentMethods: ["connect", "health"],
      stdout: [],
    });
    expect(harness.close).toHaveBeenCalledOnce();
  },
);

it("accepts only an idle future suspension lease", () => {
  const payload = readyPayload(2_000);
  const response = (overrides = {}) => adminResponse({ ...payload, ...overrides });

  expect(assertReadySuspensionResponse(response(), 1_000)).toEqual(payload);
  expect(() => assertReadySuspensionResponse(response({ expiresAtMs: 999 }), 1_000)).toThrow(
    "expire in the future",
  );
  expect(() => assertReadySuspensionResponse(response({ activeCount: 1 }), 1_000)).toThrow(
    "no active work",
  );
});

it("requires canonical prepared-suspension RPC and probe evidence", () => {
  const suspendedError = {
    ok: false,
    error: {
      code: "UNAVAILABLE",
      retryable: true,
      details: { reason: "gateway-suspending", phase: "prepared" },
    },
  };
  const health = { status: 200, body: { ok: true, status: "live" } };
  const readiness = { status: 503, body: { ready: false, failing: ["gateway-draining"] } };

  expect(() => assertGatewaySuspendingError(suspendedError)).not.toThrow();
  expect(() => assertSuspendedProbes(health, readiness)).not.toThrow();
  expect(() =>
    assertGatewaySuspendingError({
      ...suspendedError,
      error: {
        ...suspendedError.error,
        details: { reason: "gateway-restarting", phase: "prepared" },
      },
    }),
  ).toThrow("identify gateway suspension");
  expect(() =>
    assertSuspendedProbes(health, {
      status: 503,
      body: { ready: false, failing: ["channels"] },
    }),
  ).toThrow("identify gateway-draining");
});
