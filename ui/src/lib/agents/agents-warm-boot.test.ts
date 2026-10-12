import { expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentCapability } from "./index.ts";

it("retires visible discovery after a failed refresh and retries without the previous roster", async () => {
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
    .mockRejectedValueOnce(new Error("role changed; reconnect"))
    .mockResolvedValueOnce(current);
  const agents = createAgentCapability({
    snapshot: { client: createTestGatewayClient(request), phase: "connected" },
    subscribe: () => () => {},
  });
  try {
    await agents.ensureList();
    expect(agents.state.agentsList).toEqual(previous);
    await agents.refreshList();
    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsError).toContain("role changed; reconnect");
    await expect(agents.ensureList()).resolves.toEqual(current);
    expect(agents.state.agentsList).toEqual(current);
    expect(agents.state.agentsError).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    agents.dispose();
  }
});
