import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createConfigOverride,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  supportedSpawnModelChoice,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
}));

type SpawnSubagentTestContext = Parameters<
  typeof import("./subagent-spawn.js").spawnSubagentDirect
>[1] & {
  requesterThinkingExplicit?: boolean;
};
type ThinkingProvenanceCase = {
  name: string;
  requesterState: Readonly<Record<string, unknown>>;
  context: SpawnSubagentTestContext;
  requesterThinkingDefault?: string;
  spawnThinking?: string;
  expected?: string;
};

let configOverride: Record<string, unknown>;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function spawn(
  params: Parameters<typeof spawnSubagentDirect>[0],
  ctx: SpawnSubagentTestContext = {},
) {
  return spawnSubagentDirect(params, { agentSessionKey: "agent:main:main", ...ctx });
}

function captureStore() {
  let captured: Record<string, Record<string, unknown>> = {};
  installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
    onStore: (store) => {
      captured = store;
    },
  });
  return () => captured;
}

const thinkingCases: readonly ThinkingProvenanceCase[] = [
  {
    name: "inherits an explicitly selected active-turn level",
    requesterState: { thinkingLevel: "medium" },
    context: { requesterThinkingLevel: "ultra", requesterThinkingExplicit: true },
    expected: "ultra",
  },
  {
    name: "keeps legacy inheritance for unknown active-turn provenance",
    requesterState: { thinkingLevel: "medium" },
    context: { requesterThinkingLevel: "ultra" },
    expected: "ultra",
  },
  {
    name: "does not save an automatic active level or a stale saved preference",
    requesterState: { thinkingLevel: "medium" },
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    expected: undefined,
  },
  {
    name: "does not save an automatic parent tier for a child that can later switch models",
    requesterState: {},
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    expected: undefined,
  },
  {
    name: "does not save a requester model default when no active level was selected",
    requesterState: {},
    context: {},
    expected: undefined,
  },
  {
    name: "preserves an explicit spawn override over an automatic parent tier",
    requesterState: {},
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    spawnThinking: "low",
    expected: "low",
  },
  {
    name: "inherits a persisted requester choice when active provenance is unknown",
    requesterState: { thinkingLevel: "off" },
    context: {},
    expected: "off",
  },
  {
    name: "inherits a configured requester choice when active provenance is unknown",
    requesterState: {},
    context: {},
    requesterThinkingDefault: "high",
    expected: "high",
  },
];

describe("subagent thinking provenance", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      ...hoisted,
      getRuntimeConfig: () => configOverride,
      resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
      sessionStorePath: "/tmp/subagent-thinking-provenance-session-store.json",
    }));
  });

  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.prepareModelChoiceMock.mockImplementation(supportedSpawnModelChoice);
    hoisted.startQueuedSubagentRunMock.mockResolvedValue(true);
    hoisted.settleFailedQueuedSubagentLaunchMock.mockResolvedValue(true);
    configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    hoisted.loadSessionStoreMock.mockReturnValue({});
  });

  it.each(thinkingCases)("$name", async (testCase) => {
    configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          ...(testCase.requesterThinkingDefault
            ? { thinkingDefault: testCase.requesterThinkingDefault }
            : {}),
        },
        entries: { main: { workspace: "/tmp/workspace-main" } },
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": testCase.requesterState });
    const readStore = captureStore();

    const result = await spawn(
      { task: `provenance: ${testCase.name}`, thinking: testCase.spawnThinking },
      testCase.context,
    );

    expect(result.status).toBe("accepted");
    expect(readStore()[result.childSessionKey!]?.thinkingLevel).toBe(testCase.expected);
  });
});
