// mcp.reloadRuntimes runs the Gateway's lease-preserving MCP config reload and
// revalidates the caller's mutation authority immediately before it (#164642).
import { describe, expect, it, vi } from "vitest";
import * as managerApi from "../../agents/agent-bundle-mcp-manager-api.js";
import { mcpAppHandlers } from "./mcp-app.js";

function handlerOptions() {
  const respond = vi.fn();
  const hasCurrentClientAuthority = vi.fn(() => true);
  const options = {
    request: { method: "mcp.reloadRuntimes", params: {} },
    params: {},
    respond,
    client: {},
    hasCurrentClientAuthority,
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as Parameters<(typeof mcpAppHandlers)["mcp.reloadRuntimes"]>[0];
  return { options, respond, hasCurrentClientAuthority };
}

describe("mcp.reloadRuntimes", () => {
  it("reloads runtimes and revalidates the caller authority", async () => {
    const reloadSpy = vi.spyOn(managerApi, "reloadSessionMcpRuntimes").mockResolvedValue(undefined);
    const { options, hasCurrentClientAuthority } = handlerOptions();
    const respond = options.respond;
    const handler = mcpAppHandlers["mcp.reloadRuntimes"];
    expect(handler).toBeDefined();

    await handler(options);

    expect(hasCurrentClientAuthority).toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy.mock.calls[0]?.[0]).toMatchObject({ reloadPlugins: false });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, reloaded: true });
    reloadSpy.mockRestore();
  });

  it("reports reload failures instead of acknowledging them", async () => {
    vi.spyOn(managerApi, "reloadSessionMcpRuntimes").mockRejectedValue(new Error("reload boom"));
    const { options, respond } = handlerOptions();
    const handler = mcpAppHandlers["mcp.reloadRuntimes"];

    await handler(options);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(String(respond.mock.calls[0]?.[2])).toContain("reload boom");
    vi.restoreAllMocks();
  });
});
