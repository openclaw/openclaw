import os from "node:os";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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
  template?: "declared" | "undeclared";
  spawnThinking?: string;
  expected?: string;
};

let configOverride: Record<string, unknown>;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

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

function gatewayRequest(method: string): Record<string, unknown> {
  const call = hoisted.callGatewayMock.mock.calls.find(
    ([arg]) => requireRecord(arg).method === method,
  );
  return requireRecord(call?.[0]);
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
    name: "inherits the active automatic level instead of a stale saved preference",
    requesterState: { thinkingLevel: "medium" },
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    expected: "high",
  },
  {
    name: "keeps an unselected declared Qwen child at its template default",
    requesterState: {},
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    template: "declared",
    expected: undefined,
  },
  {
    name: "inherits automatic thinking for an undeclared binary template",
    requesterState: {},
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    template: "undeclared",
    expected: "high",
  },
  {
    name: "preserves an explicit spawn override for a declared Qwen child",
    requesterState: {},
    context: { requesterThinkingLevel: "high", requesterThinkingExplicit: false },
    template: "declared",
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
    if (testCase.template) {
      hoisted.prepareModelChoiceMock.mockImplementation(async (params) => {
        const choice = await supportedSpawnModelChoice(params);
        if (choice.kind !== "resolved") {
          return choice;
        }
        return {
          ...choice,
          model: {
            ...choice.model,
            reasoning: true,
            compat: {
              thinkingFormat: "qwen-chat-template",
              ...(testCase.template === "declared"
                ? { supportedReasoningEfforts: ["low", "medium", "xhigh"] }
                : {}),
            },
          },
        };
      });
    }
    const readStore = captureStore();

    const result = await spawn(
      { task: `provenance: ${testCase.name}`, thinking: testCase.spawnThinking },
      testCase.context,
    );

    expect(result.status).toBe("accepted");
    expect(readStore()[result.childSessionKey!]?.thinkingLevel).toBe(testCase.expected);
    expect(requireRecord(gatewayRequest("agent").params).thinking).toBe(testCase.spawnThinking);
  });

  it("marks persisted requester thinking as explicit", async () => {
    const { readRequesterPreferences } = await import("./subagent-spawn-requester-prefs.js");
    hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": { thinkingLevel: "low" } });

    const preferences = await readRequesterPreferences({
      cfg: {},
      requesterInternalKey: "agent:main:main",
      requesterAgentId: "main",
    });

    expect(preferences.thinkingLevel).toBe("low");
    expect(preferences.thinkingExplicit).toBe(true);
  });

  it("marks configured requester-model thinking as explicit", async () => {
    const { readRequesterPreferences } = await import("./subagent-spawn-requester-prefs.js");

    const preferences = await readRequesterPreferences({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-5" },
            models: { "anthropic/claude-opus-5": { params: { thinking: "high" } } },
          },
        },
      },
      requesterInternalKey: "agent:main:main",
      requesterAgentId: "main",
    });

    expect(preferences.thinkingLevel).toBe("high");
    expect(preferences.thinkingExplicit).toBe(true);
  });

  it("does not mark a model-resolved requester default as explicit", async () => {
    const { readRequesterPreferences } = await import("./subagent-spawn-requester-prefs.js");

    const preferences = await readRequesterPreferences({
      cfg: { agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } },
      requesterInternalKey: "agent:main:main",
      requesterAgentId: "main",
    });

    expect(preferences.thinkingLevel).toBeDefined();
    expect(preferences.thinkingExplicit).toBe(false);
  });
});
