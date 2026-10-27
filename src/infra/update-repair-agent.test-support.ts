import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { runUpdateRepairTurn } from "./update-repair-agent.runtime.js";

type Turn = Parameters<typeof runUpdateRepairTurn>[0];
export async function createRepairAuthRuntime() {
  const [{ createExternalAuthRuntime }, { createAuthProfileStoreRuntime }] = await Promise.all([
    import("../agents/auth-profiles/external-auth.js"),
    import("../agents/auth-profiles/store.js"),
  ]);
  return createAuthProfileStoreRuntime(
    createExternalAuthRuntime(
      () => [],
      async (_params, run) => run(),
    ),
  );
}

export function repairRoute(
  agentDir: string,
  config: OpenClawConfig = {},
  authProfileId?: string,
): Turn["route"] {
  return {
    runner: "embedded",
    provider: "fixture",
    model: "repair",
    modelLabel: "fixture/repair",
    agentId: "owner",
    agentDir,
    authProfileId,
    runConfig: config,
    sourceConfig: config,
  };
}

export function repairTurnInput(
  state: OpenClawTestState,
  {
    config = { plugins: { enabled: false } },
    authProfileId,
    ...overrides
  }: Partial<Turn> & { config?: OpenClawConfig; authProfileId?: string } = {},
): Turn {
  return {
    target: { ...state, installRoot: state.workspaceDir },
    route: repairRoute(state.agentDir("owner"), config, authProfileId),
    modelFallbacks: [],
    prompt: "Repair.",
    timeoutMs: 10_000,
    maxToolCalls: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function repairModel(
  id = "repair",
  name = "Synthetic repair",
  maxTokens = 1024,
): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens,
  };
}
