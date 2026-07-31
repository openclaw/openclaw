import { describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliAgentId } from "./agent-selection.js";

describe("resolveCliAgentId", () => {
  it("keeps sole-agent non-interactive selection implicit", async () => {
    await expect(
      resolveCliAgentId({
        cfg: { agents: { entries: { solo: {} } } },
        runtime: defaultRuntime,
        surface: "test command",
        deps: { interactive: false },
      }),
    ).resolves.toBe("solo");
  });

  it("accepts explicit main for a rosterless legacy config", async () => {
    await expect(
      resolveCliAgentId({
        cfg: {},
        runtime: defaultRuntime,
        agentInput: "main",
        surface: "test command",
        deps: { interactive: false },
      }),
    ).resolves.toBe("main");
  });

  it("raises a typed actionable error for non-interactive multi-agent selection", async () => {
    await expect(
      resolveCliAgentId({
        cfg: { agents: { entries: { ops: {}, research: {} } } },
        runtime: defaultRuntime,
        surface: "test command",
        deps: { interactive: false },
      }),
    ).rejects.toMatchObject({
      name: "AgentSelectionRequiredError",
      code: "AGENT_SELECTION_REQUIRED",
      agentIds: ["ops", "research"],
      surface: "test command",
    } satisfies Partial<AgentSelectionRequiredError>);
  });

  it("prompts on an interactive multi-agent terminal", async () => {
    const selectAgent = vi.fn(async () => "research");
    await expect(
      resolveCliAgentId({
        cfg: {
          agents: {
            entries: { ops: { name: "Operations" }, research: { name: "Research" } },
          },
        },
        runtime: defaultRuntime,
        surface: "test command",
        deps: { interactive: true, selectAgent },
      }),
    ).resolves.toBe("research");
    expect(selectAgent).toHaveBeenCalledWith({
      message: "Select an agent for test command",
      options: [
        { value: "ops", label: "Operations (ops)" },
        { value: "research", label: "Research (research)" },
      ],
    });
  });
});
