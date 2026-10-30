import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";
import {
  adversarialResolved,
  escapeHeavyResolved,
  expectExactResolvedAcknowledgement,
  expectOmittedResolvedAcknowledgement,
} from "./sessions-tool.test-helpers.js";

const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => gatewayMocks.callGateway.mockReset());

function createTool(options: Partial<Parameters<typeof createSessionsTool>[0]> = {}) {
  return createSessionsTool({
    agentSessionKey: "agent:main:main",
    config: {},
    hasInProcessGatewayContext: () => true,
    ...options,
  });
}

describe("sessions tool responses", () => {
  it("clears its model override when patch requests the default model", async () => {
    const callGateway = vi.fn().mockResolvedValue({});
    await createTool({ callGateway }).execute("reset-model", { action: "patch", model: "default" });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: { key: "agent:main:main", model: null },
    });
  });

  it("routes group actions to existing gateway methods", async () => {
    gatewayMocks.callGateway.mockImplementation(async (request) => request);
    const tool = createTool();
    const rejects = (params: Record<string, unknown>, message: string) =>
      expect(tool.execute("invalid", params)).rejects.toThrow(message);

    await tool.execute("list", { action: "group_list" });
    await tool.execute("set", { action: "group_set", names: ["Now", "Later"] });
    await tool.execute("rename", { action: "group_rename", name: "Now", to: "Next" });
    await tool.execute("delete", { action: "group_delete", name: "Later" });

    expect(gatewayMocks.callGateway.mock.calls).toEqual([
      [{ method: "sessions.groups.list", params: {} }],
      [{ method: "sessions.groups.put", params: { names: ["Now", "Later"] } }],
      [{ method: "sessions.groups.rename", params: { name: "Now", to: "Next" } }],
      [{ method: "sessions.groups.delete", params: { name: "Later" } }],
    ]);
    await rejects({ action: "group_set" }, "names required");
    await rejects({ action: "group_set", names: ["Now", null] }, "names[1] required");
    expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: "fitting", resolved: adversarialResolved, omitted: false },
    { name: "oversized", resolved: escapeHeavyResolved, omitted: true },
  ])("bounds $name resolved metadata", async ({ resolved, omitted }) => {
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved,
    });
    const result = await createTool().execute("patch-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toMatchObject({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
    });
    if (omitted) {
      expectOmittedResolvedAcknowledgement(result);
    } else {
      expectExactResolvedAcknowledgement(result, resolved);
    }
  });
});
