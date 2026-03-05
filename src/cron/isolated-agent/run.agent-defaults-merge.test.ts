import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveAgentConfigMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — defaults merge", () => {
  setupRunCronIsolatedAgentTurnSuite();

  function getMergedDefaults(): Record<string, unknown> {
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    const cfg = runWithModelFallbackMock.mock.calls[0]?.[0]?.cfg as
      | { agents?: { defaults?: Record<string, unknown> } }
      | undefined;
    return cfg?.agents?.defaults ?? {};
  }

  it("preserves global defaults when per-agent fields are unset", async () => {
    const globalDefaults = {
      model: {
        primary: "openai/gpt-4.1",
        fallbacks: ["anthropic/claude-sonnet-4"],
      },
      workspace: "/tmp/global-workspace",
      thinkingDefault: "medium",
      memorySearch: { enabled: true },
      humanDelay: { enabled: true, baseMs: 500 },
      heartbeat: { every: "30m" },
      subagents: { maxSpawnDepth: 3 },
      sandbox: { enabled: true },
      tools: { web_search: { enabled: true } },
    };

    resolveAgentConfigMock.mockReturnValue({
      workspace: undefined,
      thinkingDefault: undefined,
      memorySearch: undefined,
      humanDelay: undefined,
      heartbeat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tools: undefined,
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        agentId: "ops",
        cfg: {
          agents: {
            defaults: globalDefaults,
            list: [{ id: "ops" }],
          },
        },
      }),
    );

    const mergedDefaults = getMergedDefaults();
    expect(mergedDefaults.model).toEqual(globalDefaults.model);
    expect(mergedDefaults.workspace).toBe(globalDefaults.workspace);
    expect(mergedDefaults.thinkingDefault).toBe(globalDefaults.thinkingDefault);
    expect(mergedDefaults.memorySearch).toEqual(globalDefaults.memorySearch);
    expect(mergedDefaults.humanDelay).toEqual(globalDefaults.humanDelay);
    expect(mergedDefaults.heartbeat).toEqual(globalDefaults.heartbeat);
    expect(mergedDefaults.subagents).toEqual(globalDefaults.subagents);
    expect(mergedDefaults.sandbox).toEqual(globalDefaults.sandbox);
    expect(mergedDefaults.tools).toEqual(globalDefaults.tools);
  });

  it("still applies explicit per-agent defaults when provided", async () => {
    resolveAgentConfigMock.mockReturnValue({
      workspace: "/tmp/agent-workspace",
      thinkingDefault: "off",
      heartbeat: { every: "10m" },
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        agentId: "ops",
        cfg: {
          agents: {
            defaults: {
              workspace: "/tmp/global-workspace",
              thinkingDefault: "high",
              heartbeat: { every: "30m" },
            },
            list: [{ id: "ops" }],
          },
        },
      }),
    );

    const mergedDefaults = getMergedDefaults();
    expect(mergedDefaults.workspace).toBe("/tmp/agent-workspace");
    expect(mergedDefaults.thinkingDefault).toBe("off");
    expect(mergedDefaults.heartbeat).toEqual({ every: "10m" });
  });
});
