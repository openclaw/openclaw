// Model auth-order tests cover user-facing order output and persisted updates.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  externalCliDiscoveryForProviderAuth: vi.fn(() => ({ kind: "none" })),
  loadModelsConfig: vi.fn(),
  setAuthProfileOrder: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/openclaw-agent.sqlite`,
  setAuthProfileOrder: mocks.setAuthProfileOrder,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveModelsTargetAgent: (_cfg: OpenClawConfig, rawAgentId?: string) => {
    const agentId = rawAgentId ?? "main";
    return { agentDir: `/tmp/openclaw/agents/${agentId}`, agentId };
  },
}));

import {
  modelsAuthOrderClearCommand,
  modelsAuthOrderGetCommand,
  modelsAuthOrderSetCommand,
} from "./auth-order.js";

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    },
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createStore(order?: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:api-smoke": {
        type: "api_key",
        provider: "openai",
        key: "api-secret",
      },
      "openai:codex-smoke": {
        type: "oauth",
        provider: "openai",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: 1_800_000_000_000,
      },
    },
    ...(order ? { order: { openai: order } } : {}),
  };
}

describe("models auth order output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
  });

  it("describes the saved auth profile order without override jargon", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(
      createStore(["openai:codex-smoke", "openai:api-smoke"]),
    );
    const runtime = createRuntime();

    await modelsAuthOrderGetCommand({ provider: "openai" }, runtime);

    expect(runtime.logs).toEqual([
      "Agent: main",
      "Provider: openai",
      "Auth state store: /tmp/openclaw/agents/main/openclaw-agent.sqlite",
      "Auth profile order: openai:codex-smoke, openai:api-smoke",
    ]);
  });

  it("explains the fallback when no custom order is set", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(createStore());
    const runtime = createRuntime();

    await modelsAuthOrderGetCommand({ provider: "openai" }, runtime);

    expect(runtime.logs.at(-1)).toBe("Auth profile order: (not set; using config/round-robin)");
  });

  it("reports the order after setting it", async () => {
    const store = createStore();
    const order = ["openai:codex-smoke", "openai:api-smoke"];
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.setAuthProfileOrder.mockResolvedValue(createStore(order));
    const runtime = createRuntime();

    await modelsAuthOrderSetCommand({ provider: "openai", order }, runtime);

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      provider: "openai",
      order,
    });
    expect(runtime.logs.at(-1)).toBe("Auth profile order: openai:codex-smoke, openai:api-smoke");
  });

  it("explains the fallback after clearing the order", async () => {
    mocks.setAuthProfileOrder.mockResolvedValue(createStore());
    const runtime = createRuntime();

    await modelsAuthOrderClearCommand({ provider: "openai" }, runtime);

    expect(runtime.logs.at(-1)).toBe("Auth profile order cleared; using config/round-robin.");
  });
});
