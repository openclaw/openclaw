import { expect, it, vi } from "vitest";
import {
  resolvePluginSessionWorkDispatch,
  readPluginSessionWorkAuthority,
  runWithPluginSessionWorkAuthority,
} from "./plugin-session-work-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const context = {} as GatewayRequestContext;
function fixture() {
  const controller = new AbortController();
  const authority = {
    target: { agentId: "main", sessionKey: "agent:main:research", sessionId: "session" },
    pluginId: "research",
    context,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    assertToolAllowed: vi.fn((tool: string) => {
      if (tool !== "web_search") {
        throw new Error("denied tool");
      }
    }),
  };
  const request = {
    method: "tools.invoke",
    context,
    scopedPluginId: "research",
    pluginRuntimeOwnerId: "research",
    params: { agentId: "main", sessionKey: "agent:main:research", name: "web_search" },
  };
  return { controller, authority, request };
}
it("allows only the exact scoped plugin, gateway, conversation and admitted tool", () => {
  const { authority, request } = fixture();
  runWithPluginSessionWorkAuthority(authority, () => {
    expect(readPluginSessionWorkAuthority()).toBe(authority);
    expect(() => resolvePluginSessionWorkDispatch(request)).not.toThrow();
    expect(authority.assertToolAllowed).toHaveBeenCalledWith("web_search");
    for (const change of [
      { context: {} as GatewayRequestContext },
      { scopedPluginId: "other" },
      { scopedPluginId: undefined },
      { pluginRuntimeOwnerId: "other" },
    ]) {
      expect(() => resolvePluginSessionWorkDispatch({ ...request, ...change })).toThrow(
        "another plugin or Gateway",
      );
    }
    for (const params of [
      { ...request.params, agentId: "other" },
      { ...request.params, sessionKey: "other" },
    ]) {
      expect(() => resolvePluginSessionWorkDispatch({ ...request, params })).toThrow(
        "another conversation",
      );
    }
    expect(() => resolvePluginSessionWorkDispatch({ ...request, method: "agent" })).toThrow(
      "registered session-tool",
    );
    expect(() =>
      resolvePluginSessionWorkDispatch({ ...request, params: { ...request.params, name: "exec" } }),
    ).toThrow("denied tool");
  });
  expect(readPluginSessionWorkAuthority()).toBeUndefined();
});
it("checks revocation again at the dispatch boundary", () => {
  const { authority, request, controller } = fixture();
  runWithPluginSessionWorkAuthority(authority, () => {
    controller.abort(new Error("revoked"));
    expect(() => resolvePluginSessionWorkDispatch(request)).toThrow("revoked");
  });
});
