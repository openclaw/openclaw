import "./sessions-spawn-tool.mocks.test-support.js";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;

// Visible children are created through `sessions.create`, which rejects an
// explicit thinkingLevel the child cannot support. These cases pin how the
// spawn tool picks the level it forwards; the real creation boundary is covered
// in `src/gateway/server.sessions.agent-model-catalog.test.ts`.
describe("sessions_spawn visible child thinking", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  });

  beforeEach(() => {
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.inProcessCreationMock.mockReset();
  });

  const requireRecord = createRequireRecord("record", "expected-label");

  function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
    const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
    return requireRecord(calls?.[callIndex]?.[argIndex], `${label} argument ${argIndex}`);
  }

  it("persists configured subagent thinking for visible sessions", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterThinkingLevel: "xhigh",
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            thinkingDefault: "xhigh",
            subagents: {
              model: "openai/gpt-5.6-luna",
              thinking: "max",
            },
          },
          entries: { main: {} },
        },
      },
      callGateway: callGateway as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await tool.execute("visible-thinking", {
      task: "inspect issue",
      visible: true,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        model: "openai/gpt-5.6-luna",
        thinkingLevel: "max",
      }),
    );
  });

  it("clamps inherited thinking to the visible child's selected runtime", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterThinkingLevel: "xhigh",
      config: {
        agents: {
          defaults: {
            model: { primary: "demo/demo-model" },
          },
          entries: { main: {} },
        },
      },
      callGateway: callGateway as never,
      // The prepared catalog carries no entry for this model, so runtime policy
      // alone has to clamp the inherited level.
      loadModelCatalog: (async () => []) as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await tool.execute("visible-inherited-thinking", {
      task: "inspect issue",
      visible: true,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        model: "demo/demo-model",
        thinkingLevel: "high",
      }),
    );
  });

  it("clamps inherited thinking against a profile-qualified child's canonical model", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterThinkingLevel: "ultra",
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-luna@openai:work" },
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
            },
          },
          entries: { main: {} },
        },
      },
      callGateway: callGateway as never,
      loadModelCatalog: (async () => []) as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await tool.execute("visible-profile-thinking", {
      task: "inspect issue",
      visible: true,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        model: "openai/gpt-5.6-luna@openai:work",
        thinkingLevel: "ultra",
      }),
    );
  });

  it("omits inherited thinking when the prepared child catalog cannot be read", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const loadModelCatalog = vi.fn(async () => {
      throw new Error("catalog generation superseded");
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterThinkingLevel: "high",
      config: {
        agents: {
          defaults: { model: { primary: "demo/demo-off" } },
          entries: { main: {} },
        },
      },
      callGateway: callGateway as never,
      loadModelCatalog: loadModelCatalog as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-unverifiable-thinking", {
      task: "inspect issue",
      visible: true,
    });

    // An unverifiable level must not be forwarded: `sessions.create` rejects an
    // explicit level it cannot support, so creation would fail where the
    // pre-inheritance spawn (which sent no level at all) succeeded.
    expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible" });
    expect(mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty("thinkingLevel");
  });

  it("clamps inherited thinking against the canonical model behind an explicit alias", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const loadModelCatalog = vi.fn(async () => [
      {
        id: "demo-max",
        provider: "demo",
        reasoning: true,
        thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      },
    ]);
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterThinkingLevel: "max",
      config: {
        agents: {
          defaults: {
            model: { primary: "demo/demo-base" },
            models: { "demo/demo-max": { alias: "demo-fast" } },
          },
          entries: { main: {} },
        },
      },
      callGateway: callGateway as never,
      loadModelCatalog: loadModelCatalog as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await tool.execute("visible-alias-thinking", {
      task: "inspect issue",
      visible: true,
      model: "demo-fast@work",
    });

    // The bare alias carries no provider, so an unresolved lookup grades `max`
    // against the default provider and reduces it to the generic `high`.
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        model: "demo/demo-max@work",
        thinkingLevel: "max",
      }),
    );
  });

  // `sessions.create` grades an explicit `thinkingLevel` against the concrete
  // runtime row it selects from `routeVariants`, not against the logical row.
  // A clamp that reads logical rows only therefore disagrees with the validator
  // in both directions: it keeps a level native selection rejects (creation
  // fails where an omitted level used to succeed), and it drops a level the
  // native row does support (silent downgrade).
  // These cases use the flat row list a legacy array-returning loader yields.
  // The prepared-snapshot shape (`entries` plus `routeVariants`) is pinned
  // through real creation and persistence in
  // `server.sessions.agent-model-catalog.test.ts`.
  it.each([
    {
      name: "clamps down to the selected native runtime row (flat catalog)",
      logicalEfforts: ["max"],
      nativeEfforts: ["high"],
      inherited: "max",
      expected: "high",
    },
    {
      name: "keeps effort the selected native runtime row supports (flat catalog)",
      logicalEfforts: ["high"],
      nativeEfforts: ["max"],
      inherited: "max",
      expected: "max",
    },
  ])("$name", async ({ logicalEfforts, nativeEfforts, inherited, expected }) => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const logical = {
      id: "reasoner",
      provider: "runtime-fixture",
      name: "Reasoner",
      reasoning: true,
      compat: { supportedReasoningEfforts: logicalEfforts },
    };
    const native = {
      ...logical,
      nativeRuntime: "fixture-native",
      compat: { supportedReasoningEfforts: nativeEfforts },
    };
    const loadModelCatalog = vi.fn(async () => [logical, native]);
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterThinkingLevel: inherited as never,
      config: {
        agents: {
          defaults: {
            model: { primary: "runtime-fixture/reasoner" },
            models: {
              "runtime-fixture/reasoner": { agentRuntime: { id: "fixture-native" } },
            },
          },
          entries: { main: {} },
        },
      },
      callGateway: callGateway as never,
      loadModelCatalog: loadModelCatalog as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await tool.execute(`visible-runtime-variant-flat-${expected}`, {
      task: "inspect issue",
      visible: true,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        model: "runtime-fixture/reasoner",
        thinkingLevel: expected,
      }),
    );
  });
});
