import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  setAuthProfileOrder: vi.fn(),
  loadModelsConfig: vi.fn(),
  resolveModelsTargetAgent: vi.fn((_cfg: OpenClawConfig, rawAgentId?: string) => ({
    agentId: rawAgentId ?? "main",
    agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
  })),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
}));

// mock-isolation: Order tests record fixture writes instead of mutating persistent credentials.
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: async (...args: unknown[]) => mocks.ensureAuthProfileStore(...args),
  setAuthProfileOrder: mocks.setAuthProfileOrder,
  externalCliDiscoveryForProviderAuth: () => undefined,
  resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/auth-profiles.json`,
}));

// mock-isolation: auth-order cases supply their own config without reading operator state.
vi.mock("./load-config.js", () => ({ loadModelsConfig: mocks.loadModelsConfig }));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return { ...actual, resolveModelsTargetAgent: mocks.resolveModelsTargetAgent };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

const { modelsAuthOrderGetCommand, modelsAuthOrderUpdateCommand } = await import("./auth-order.js");

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;

function storeWith(ids: string[], order?: string[], provider = "anthropic"): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      ids.map((profileId) => [
        profileId,
        { type: "oauth" as const, provider: profileId.split(":")[0] ?? "anthropic", access: "tok" },
      ]),
    ),
    ...(order ? { order: { [provider]: order } } : {}),
  } as unknown as AuthProfileStore;
}

describe("models auth order", () => {
  const order = ["anthropic:b", "anthropic:a"];
  function expectWrite(agent: string, provider: string, ids: string[] | null) {
    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: `/tmp/agent-${agent}`,
      provider,
      order: ids,
    });
  }
  function expectTarget(agent: string | undefined, kind: "read" | "mutation") {
    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), agent, { kind });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(storeWith(order.toReversed(), ["anthropic:a"]));
    mocks.setAuthProfileOrder.mockResolvedValue(storeWith(["anthropic:a", "anthropic:b"], order));
  });

  it("get resolves an omitted agent through the read target", async () => {
    await modelsAuthOrderGetCommand({ provider: "anthropic" }, runtime);

    expectTarget(undefined, "read");
    expect(runtime.log).toHaveBeenCalledWith("Agent: main");
  });

  it.each([
    { agent: "ops", order, message: "Auth profile order override: anthropic:b, anthropic:a" },
    {
      agent: undefined,
      order: null,
      message: expect.stringContaining("Auth profile order override cleared"),
    },
  ])(
    "writes order $order for $agent and refreshes the gateway",
    async ({ agent, order: ids, message }) => {
      await modelsAuthOrderUpdateCommand({ provider: "anthropic", agent, order: ids }, runtime);
      expectWrite(agent ?? "main", "anthropic", ids);
      expectTarget(agent, "mutation");
      expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith(
        agent ?? "main",
        "update",
        runtime,
      );
      expect(runtime.log).toHaveBeenCalledWith(message);
    },
  );

  it("accepts alias-provider profiles and reports the canonical stored order", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(storeWith(["xai:a"]));
    mocks.setAuthProfileOrder.mockResolvedValue(storeWith([], ["xai:a"], "xai"));

    await modelsAuthOrderUpdateCommand({ provider: "x-ai", order: ["xai:a"] }, runtime);

    expectWrite("main", "xai", ["xai:a"]);
    expect(runtime.log).toHaveBeenCalledWith("Auth profile order override: xai:a");
  });

  it("does not refresh the gateway when the store update fails", async () => {
    mocks.setAuthProfileOrder.mockResolvedValue(null);

    await expect(
      modelsAuthOrderUpdateCommand({ provider: "anthropic", order: ["anthropic:a"] }, runtime),
    ).rejects.toThrow("Failed to update auth state");
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });
});
