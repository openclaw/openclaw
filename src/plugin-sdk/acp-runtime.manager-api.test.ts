/** Reset custody remains core-internal without removing supported plugin operations. */
import { afterEach, expect, it, vi } from "vitest";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import { getAcpSessionManager, testing } from "./acp-runtime.js";

afterEach(() => {
  testing.resetAcpSessionManagerForTests();
  vi.restoreAllMocks();
});

it("warns once for synchronous resolution and leaves asynchronous resolution quiet", async () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  await withPluginRuntimePluginScope({ pluginId: "acp-resolution-deprecation" }, async () => {
    const manager = getAcpSessionManager();
    const target = { cfg: {}, sessionKey: "" };
    expect(await manager.resolveSessionAsync(target)).toEqual({ kind: "none", sessionKey: "" });
    expect(warning).not.toHaveBeenCalled();
    expect(manager.resolveSession(target)).toEqual({ kind: "none", sessionKey: "" });
    expect(manager.resolveSession(target)).toEqual({ kind: "none", sessionKey: "" });
  });
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0]?.[0]).toContain("AcpSessionManager.resolveSessionAsync");
  expect(warning.mock.calls[0]?.[0]).toContain("Final compatibility day: 2026-12-31");
  expect(warning.mock.calls[0]?.[0]).toContain("first January 2027 stable release");
});

it("preserves the plugin manager operations without exposing reset-only custody", () => {
  const manager = getAcpSessionManager();
  expect(manager.resolveSession({ cfg: {}, sessionKey: "" })).toEqual({
    kind: "none",
    sessionKey: "",
  });
  for (const operation of [
    "initializeSession",
    "runTurn",
    "cancelSession",
    "closeSession",
    "getObservabilitySnapshot",
  ] as const) {
    expect(manager[operation]).toBeTypeOf("function");
  }
  expect(manager).not.toHaveProperty("captureSessionRuntimeOwnership");
  expect(manager).not.toHaveProperty("forceDiscardSessionRuntime");
});
