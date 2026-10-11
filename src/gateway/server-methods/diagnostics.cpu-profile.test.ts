import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { captureDiagnosticCpuProfile } from "../../logging/diagnostic-cpu-profile.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { handleGatewayRequest } from "../server-methods.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import type { GatewayRequestOptions } from "./types.js";

const capture = vi.hoisted(() => vi.fn());
const captureHeap = vi.hoisted(() => vi.fn());
vi.mock("../../logging/diagnostic-cpu-profile.js", () => ({
  captureDiagnosticCpuProfile: capture,
}));
vi.mock("../../logging/diagnostic-heap-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/diagnostic-heap-profile.js")>()),
  captureDiagnosticHeapProfile: captureHeap,
}));

const result = {
  requestedDurationMs: 5_000,
  actualDurationMs: 5_015,
  startBlockedMs: 2_100,
  samplingIntervalMicros: 10_000,
  sampleLossCount: null,
  redactedNodeCount: 1,
  profile: {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "[redacted]",
          scriptId: "12",
          url: "",
          lineNumber: -10,
          columnNumber: -200,
        },
        positionTicks: [{ line: -9, ticks: 1 }],
      },
    ],
    startTime: 0,
    endTime: 5_015_000,
    samples: [2],
    timeDeltas: [10_000],
  },
};

const heapResult = {
  durationMs: 5_000,
  samplingIntervalBytes: 32_768,
  includeObjectsCollectedByMajorGC: false,
  includeObjectsCollectedByMinorGC: false,
  heapUsedBefore: 100,
  heapUsedAfter: 200,
  rssBefore: 300,
  rssAfter: 400,
  truncated: false,
};

function request(
  options: {
    method?: "diagnostics.cpuProfile" | "diagnostics.heapProfile";
    scopes?: string[];
    role?: string;
    params?: unknown;
    connection?: AbortController;
    gateway?: GatewayRequestEntryLifetime;
    signal?: AbortSignal;
    hasAuthority?: () => boolean;
  } = {},
) {
  const respond = vi.fn();
  const pending = handleGatewayRequest({
    req: {
      type: "req",
      id: "cpu-profile",
      method: options.method ?? "diagnostics.cpuProfile",
      params: options.params,
    },
    respond,
    client: {
      connId: "profile-client",
      connectionSignal: options.connection?.signal,
      connect: {
        role: options.role ?? "operator",
        scopes: options.scopes ?? ["operator.admin"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
      },
    } as GatewayRequestOptions["client"],
    isWebchatConnect: () => false,
    context: {
      logGateway: { warn: vi.fn() },
      requestEntryLifetime: options.gateway,
    } as unknown as GatewayRequestOptions["context"],
    signal: options.signal,
    hasCurrentClientAuthority: options.hasAuthority,
  });
  return { respond, pending };
}

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  capture
    .mockReset()
    .mockResolvedValue({ status: "complete", result } satisfies Awaited<
      ReturnType<typeof captureDiagnosticCpuProfile>
    >);
  captureHeap.mockReset().mockResolvedValue({ status: "complete", result: heapResult });
});
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("diagnostics.cpuProfile dispatch", () => {
  it.each([
    { method: "diagnostics.cpuProfile", role: "operator", scopes: ["operator.write"] },
    { method: "diagnostics.cpuProfile", role: "node", scopes: ["operator.admin"] },
    { method: "diagnostics.heapProfile", role: "operator", scopes: ["operator.write"] },
    { method: "diagnostics.heapProfile", role: "node", scopes: ["operator.admin"] },
  ] as const)("rejects $role/$scopes for $method before native work", async (options) => {
    const call = request({ ...options, scopes: [...options.scopes] });
    await call.pending;
    expect(capture).not.toHaveBeenCalled();
    expect(captureHeap).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: options.role === "node" ? "INVALID_REQUEST" : "FORBIDDEN" }),
    );
  });

  it("preserves signed-origin profiles for admin requests with empty params", async () => {
    const call = request({ params: {} });
    await call.pending;
    expect(capture).toHaveBeenCalledOnce();
    expect(call.respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it.each([null, { durationMs: 1 }])(
    "rejects nonempty/nonobject params %j before capture",
    async (params) => {
      const call = request({ params });
      await call.pending;
      expect(capture).not.toHaveBeenCalled();
      expect(call.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );

  it.each(["connection", "gateway", "request"])(
    "cancels through the existing %s lifetime and waits for cleanup",
    async (boundary) => {
      const connection = new AbortController();
      const gateway = new GatewayRequestEntryLifetime();
      const controller = new AbortController();
      const entered = createDeferred();
      const cleanup = createDeferred();
      let captureSignal: AbortSignal | undefined;
      capture.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
        captureSignal = signal;
        entered.resolve();
        await cleanup.promise;
        return { status: "unavailable", reason: "cancelled", cleanupFailed: false };
      });
      const call = request({ connection, gateway, signal: controller.signal });
      let settled = false;
      void call.pending.then(() => {
        settled = true;
      });
      await entered.promise;
      if (boundary === "connection") {
        connection.abort();
      }
      if (boundary === "gateway") {
        gateway.beginClose();
      }
      if (boundary === "request") {
        controller.abort();
      }
      expect(captureSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(call.respond).not.toHaveBeenCalled();
      cleanup.resolve();
      await call.pending;
      expect(call.respond).not.toHaveBeenCalled();
    },
  );

  it("rechecks connection authority before publishing a profile", async () => {
    let authority = true;
    capture.mockImplementation(async ({ hasAuthority }: { hasAuthority: () => boolean }) => {
      expect(hasAuthority()).toBe(true);
      authority = false;
      expect(hasAuthority()).toBe(false);
      return { status: "complete", result };
    });
    const call = request({ hasAuthority: () => authority });
    await call.pending;
    expect(call.respond).not.toHaveBeenCalled();
  });

  it("explains that all active Node tracing must be stopped first", async () => {
    capture.mockResolvedValue({
      status: "unavailable",
      reason: "tracing-active",
      cleanupFailed: false,
    });
    const call = request();
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message:
          "CPU profile unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile",
        details: { reason: "tracing-active", cleanupFailed: false },
      }),
    );
  });
});

describe("diagnostics.heapProfile dispatch", () => {
  it.each([
    undefined,
    {
      durationMs: 200,
      samplingIntervalBytes: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: false,
    },
  ])(
    "serves allocation attribution through the registered admin RPC with params %j",
    async (params) => {
      const call = request({ method: "diagnostics.heapProfile", params });
      await call.pending;
      expect(captureHeap).toHaveBeenCalledExactlyOnceWith({
        ...params,
        signal: expect.any(AbortSignal),
        hasAuthority: expect.any(Function),
      });
      expect(call.respond).toHaveBeenCalledWith(true, heapResult, undefined);
    },
  );

  it("rejects unsupported heap profile params before capture", async () => {
    const call = request({ method: "diagnostics.heapProfile", params: { filename: "profile" } });
    await call.pending;
    expect(captureHeap).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
