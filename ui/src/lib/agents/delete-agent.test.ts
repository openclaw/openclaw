import { afterEach, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { canDeleteAgent, deleteAgent } from "./delete-agent.ts";
import { createAgentCapability } from "./index.ts";

const { confirm, toast } = vi.hoisted(() => ({ confirm: vi.fn(), toast: vi.fn() }));
vi.mock("../../components/confirm-dialog.ts", async (original) => ({
  ...(await original<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: confirm,
}));
vi.mock("../toast.ts", async (original) => ({
  ...(await original<typeof import("../toast.ts")>()),
  showToast: toast,
}));
afterEach(() => vi.resetAllMocks());

async function fixture() {
  const roster: Pick<AgentsListResult, "defaultId" | "agents"> = {
    defaultId: "main",
    agents: [{ id: "main" }, { id: "research" }],
  };
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return structuredClone(roster);
    }
    return {};
  });
  const source = createApplicationGateway();
  const client = createTestGatewayClient(request);
  source.publish({
    ...source.gateway.snapshot,
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["agents.list", "agents.delete"]),
  });
  const agents = createAgentCapability(source.gateway);
  await agents.ensureList();
  return { context: { agents, gateway: source.gateway }, source, roster, request };
}

it.each(["cancel", "selection", "client", "permission", "method", "roster", "only-agent"])(
  "does not delete after %s changes during confirmation",
  async (change) => {
    const { context, source, roster, request } = await fixture();
    let current = true;
    const answer = Promise.withResolvers<boolean>();
    confirm.mockReturnValue(answer.promise);
    try {
      const pending = deleteAgent(context, { id: "research", name: "Research" }, () => current);
      expect(confirm).toHaveBeenCalledOnce();
      if (change === "selection") {
        current = false;
      }
      if (change === "client") {
        source.publish({ ...source.gateway.snapshot, client: createTestGatewayClient(vi.fn()) });
      }
      if (change === "permission" || change === "method") {
        source.publish({
          ...source.gateway.snapshot,
          hello: gatewayHelloForMethods(
            change === "method" ? ["agents.list"] : ["agents.list", "agents.delete"],
            change === "permission" ? ["operator.read"] : ["operator.admin"],
          ),
        });
      }
      if (change === "roster" || change === "only-agent") {
        roster.agents =
          change === "roster" ? [{ id: "main" }, { id: "other" }] : [{ id: "research" }];
        await context.agents.refreshList();
      }
      answer.resolve(change !== "cancel");
      await pending;
      expect(request.mock.calls.filter(([method]) => method === "agents.delete")).toHaveLength(0);
    } finally {
      context.agents.dispose();
    }
  },
);

it("excludes system and absent agents and preserves the last normal agent", async () => {
  const { context, roster } = await fixture();
  try {
    roster.agents = [{ id: "research" }, { id: "system", kind: "system" }];
    await context.agents.refreshList();
    expect(canDeleteAgent(context, "research")).toBe(false);
    expect(canDeleteAgent(context, "system")).toBe(false);
    expect(canDeleteAgent(context, "missing")).toBe(false);
    await deleteAgent(context, { id: "research", name: "Research" });
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    context.agents.dispose();
  }
});

it.each([false, true])(
  "refreshes the roster after deletion (rejected=%s) and reports errors",
  async (reject) => {
    const { context, request } = await fixture();
    confirm.mockResolvedValue(true);
    request.mockImplementation(async (method: string) => {
      if (method === "agents.delete" && reject) {
        throw new Error("Synthetic deletion failure");
      }
      return { defaultId: "main", agents: [{ id: "main" }] };
    });
    try {
      await deleteAgent(context, { id: "research", name: "Research" });
      expect(request).toHaveBeenCalledWith("agents.delete", {
        agentId: "research",
        deleteFiles: true,
      });
      expect(context.agents.state.agentsList?.agents).toEqual([{ id: "main" }]);
      if (reject) {
        expect(toast).toHaveBeenCalledWith({
          severity: "error",
          message: "Synthetic deletion failure",
        });
      } else {
        expect(toast).not.toHaveBeenCalled();
      }
    } finally {
      context.agents.dispose();
    }
  },
);
