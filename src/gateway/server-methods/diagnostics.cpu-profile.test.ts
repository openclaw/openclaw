import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { DiagnosticCpuProfileOutcome } from "../../logging/diagnostic-cpu-profile.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { handleGatewayRequest } from "../server-methods.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import type { GatewayRequestOptions } from "./types.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../../logging/diagnostic-cpu-profile.js", () => ({
  captureDiagnosticCpuProfile: capture,
}));

const result = {
  requestedDurationMs: 5_000,
  actualDurationMs: 5_015,
  samplingIntervalMicros: 10_000,
  sampleLossCount: null,
  redactedNodeCount: 0,
  profile: { nodes: [], startTime: 0, endTime: 5_015_000, samples: [], timeDeltas: [] },
};

function request(
  options: {
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
      method: "diagnostics.cpuProfile",
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
    .mockResolvedValue({ status: "complete", result } satisfies DiagnosticCpuProfileOutcome);
});
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("diagnostics.cpuProfile dispatch", () => {
  it.each([
    { role: "operator", scopes: [] },
    { role: "operator", scopes: ["operator.read"] },
    { role: "operator", scopes: ["operator.write"] },
    { role: "node", scopes: ["operator.admin"] },
  ])("rejects $role/$scopes before native work", async (options) => {
    const call = request(options);
    await call.pending;
    expect(capture).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: options.role === "node" ? "INVALID_REQUEST" : "FORBIDDEN" }),
    );
  });

  it.each([undefined, {}])(
    "lets admin request empty params %j through the lazy family",
    async (params) => {
      const call = request({ params });
      await call.pending;
      expect(capture).toHaveBeenCalledOnce();
      expect(call.respond).toHaveBeenCalledWith(true, result, undefined);
    },
  );

  it.each([null, [], "", 1, { durationMs: 1 }, { filename: "profile" }])(
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

  it("publishes a bounded, visible failure including cleanup uncertainty", async () => {
    capture.mockResolvedValue({
      status: "unavailable",
      reason: "capture-failed",
      cleanupFailed: true,
    });
    const call = request();
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "CPU profile unavailable: capture-failed",
      details: { reason: "capture-failed", cleanupFailed: true },
    });
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
