import { expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentCapability } from "./index.ts";

it("retains visible discovery after a failed refresh and replaces it on retry", async () => {
  const previous: AgentsListResult = {
    defaultId: "private",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "private", name: "Private agent" }, { id: "shared" }],
  };
  const current: AgentsListResult = { ...previous, agents: [{ id: "shared" }] };
  const request = vi
    .fn()
    .mockResolvedValueOnce(previous)
    .mockRejectedValueOnce(new Error("roster unavailable"))
    .mockResolvedValueOnce(current);
  const agents = createAgentCapability({
    snapshot: { client: createTestGatewayClient(request), phase: "connected" },
    subscribe: () => () => {},
  });
  try {
    await agents.ensureList();
    expect(agents.state.agentsList).toEqual(previous);
    await agents.refreshList();
    expect(agents.state.agentsList).toEqual(previous);
    expect(agents.state.agentsError).toContain("roster unavailable");
    await expect(agents.ensureList()).resolves.toEqual(current);
    expect(agents.state.agentsList).toEqual(current);
    expect(agents.state.agentsError).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    agents.dispose();
  }
});
