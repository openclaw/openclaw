import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestOptions } from "./types.js";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../../logging/diagnostic-heap-profile.js", () => ({
  captureDiagnosticHeapProfile: capture,
}));

const result = {
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
    scopes?: string[];
    role?: string;
    params?: unknown;
  } = {},
) {
  const respond = vi.fn();
  const pending = handleGatewayRequest({
    req: {
      type: "req",
      id: "heap-profile",
      method: "diagnostics.heapProfile",
      params: options.params,
    },
    respond,
    client: {
      connId: "profile-client",
      connect: {
        role: options.role ?? "operator",
        scopes: options.scopes ?? ["operator.admin"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
      },
    } as GatewayRequestOptions["client"],
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestOptions["context"],
  });
  return { respond, pending };
}

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  capture.mockReset().mockResolvedValue({ status: "complete", result });
});
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

describe("diagnostics.heapProfile dispatch", () => {
  it.each([
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

  it.each([
    undefined,
    {
      durationMs: 200,
      samplingIntervalBytes: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: false,
    },
    { includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: true },
  ])(
    "serves allocation attribution through the registered admin RPC with params %j",
    async (params) => {
      const call = request({ params });
      await call.pending;
      expect(capture).toHaveBeenCalledExactlyOnceWith({
        ...params,
        signal: expect.any(AbortSignal),
        hasAuthority: expect.any(Function),
      });
      expect(call.respond).toHaveBeenCalledWith(true, result, undefined);
    },
  );

  it.each([
    null,
    [],
    "",
    { durationMs: 0 },
    { durationMs: 1.5 },
    { durationMs: "5" },
    { samplingIntervalBytes: -1 },
    { samplingIntervalBytes: Infinity },
    { filename: "profile" },
    { includeObjectsCollectedByMajorGC: "true" },
    { includeObjectsCollectedByMinorGC: 1 },
  ])("rejects invalid params %j before capture", async (params) => {
    const call = request({ params });
    await call.pending;
    expect(capture).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
