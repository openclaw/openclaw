import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createAgentsListTool } from "./agents-list-tool.js";

const loadConfigMock = vi.fn<() => OpenClawConfig>();

type AgentListDetails = {
  requester?: string;
  allowAny?: boolean;
  agents?: Array<{
    id?: string;
    name?: string;
    description?: string;
    configured?: boolean;
    model?: string;
    agentRuntime?: { id?: string; source?: string };
  }>;
};

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

async function expectAgents(
  agents: unknown[],
  tool = createAgentsListTool({ agentSessionKey: "agent:main:main" }),
) {
  expect((await tool.execute("call", {})).details).toStrictEqual({
    requester: "main",
    allowAny: false,
    agents,
  });
}

function expectedAgent(
  model: string,
  agentRuntime: { id: string; source: string },
  id = "main",
  name?: string,
) {
  return { id, name, configured: true, model, agentRuntime };
}

describe("agents_list tool", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    loadConfigMock.mockReset();
  });

  it("returns model and agent runtime metadata for allowed agents", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4.5",
          subagents: { allowAgents: ["codex"] },
        },
        entries: {
          main: {},
          codex: {
            name: "Codex",
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
    } satisfies OpenClawConfig);

    const tool = createAgentsListTool({ agentSessionKey: "agent:main:main" });
    expect(tool.outputSchema).toMatchObject({
      type: "object",
      required: ["requester", "allowAny", "agents"],
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ agents: Array<{ configured: boolean; id: string; agentRuntime?: { id: string; source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session" | "session-key" }; description?: string; model?: string; name?: string }>; allowAny: boolean; requester: string }',
    );
    await expectAgents(
      [expectedAgent("openai/gpt-5.5", { id: "codex", source: "model" }, "codex", "Codex")],
      tool,
    );
  });

  it("returns trimmed descriptions only for allowed agents and omits blanks", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        entries: {
          main: { subagents: { allowAgents: ["research", "blank"] } },
          research: { name: "Research", description: "  Finds and synthesizes evidence  " },
          blank: { description: "   " },
          excluded: { description: "Excluded agent description" },
        },
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;
    expect(details.agents?.map((agent) => agent.id)).toEqual(["blank", "research"]);
    expect(details.agents?.find((agent) => agent.id === "research")).toMatchObject({
      name: "Research",
      description: "Finds and synthesizes evidence",
    });
    expect(details.agents?.find((agent) => agent.id === "blank")).not.toHaveProperty("description");
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
    expect(JSON.stringify(result)).not.toContain("Excluded agent description");
  });

  it("bounds each description without splitting a surrogate pair", async () => {
    loadConfigMock.mockReturnValue({
      agents: { entries: { main: { description: `${"a".repeat(511)}🚀tail` } } },
    } satisfies OpenClawConfig);
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    expect((result.details as AgentListDetails).agents?.[0]?.description).toBe(
      `${"a".repeat(511)}…`,
    );
  });

  it.each([
    { label: "ASCII", description: "a".repeat(600), count: 10, retained: 8, units: 1 },
    { label: "CJK", description: "漢".repeat(512), count: 4, retained: 2, units: 4 },
  ])(
    "bounds the aggregate $label description budget without dropping agents",
    async ({ description, count, retained, units }) => {
      const ids = Array.from({ length: count }, (_, index) => `agent-${index}`);
      loadConfigMock.mockReturnValue({
        agents: {
          entries: {
            main: { subagents: { allowAgents: ["*"] } },
            ...Object.fromEntries(ids.map((id) => [id, { description }])),
          },
        },
      } satisfies OpenClawConfig);
      const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
        "call",
        {},
      );
      const agents = (result.details as AgentListDetails).agents;
      expect(agents?.map((agent) => agent.id)).toEqual(["main", ...ids]);
      const descriptions =
        agents?.flatMap((agent) => (agent.description ? [agent.description] : [])) ?? [];
      expect(descriptions).toHaveLength(retained);
      expect(descriptions.reduce((total, text) => total + text.length * units, 0)).toBe(4096);
      expect(
        agents?.slice(retained + 1).every((agent) => !Object.hasOwn(agent, "description")),
      ).toBe(true);
    },
  );

  it("fits a mixed-script final description into the remaining aggregate budget", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        entries: {
          main: { description: "a".repeat(505), subagents: { allowAgents: ["*"] } },
          ...Object.fromEntries(
            Array.from({ length: 7 }, (_, index) => [
              `agent-${index}`,
              { description: "a".repeat(512) },
            ]),
          ),
          final: { description: "漢🚀more" },
          later: { description: "Omitted after budget exhaustion" },
        },
      },
    } satisfies OpenClawConfig);
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const agents = (result.details as AgentListDetails).agents;
    expect(agents?.find((agent) => agent.id === "final")?.description).toBe("漢🚀…");
    expect(agents?.find((agent) => agent.id === "later")).not.toHaveProperty("description");
    expect(agents?.[0]?.id).toBe("main");
  });

  it.each([
    {
      selection: "a plain alias",
      primary: "fast",
      model: "openai/gpt-5.6-sol",
      agentRuntime: { id: "codex", source: "model" },
    },
    {
      selection: "an explicit provider with a colliding alias",
      primary: "clawrouter/openai/gpt-5.6",
      model: "clawrouter/openai/gpt-5.6",
      agentRuntime: { id: "auto", source: "implicit" },
    },
  ])(
    "reports canonical model and runtime for $selection",
    async ({ primary, model, agentRuntime }) => {
      // Alias expansion must not redirect an explicitly named registered provider.
      loadConfigMock.mockReturnValue({
        agents: {
          defaults: {
            model: {
              primary,
            },
            models: {
              "openai/gpt-5.6-sol": {
                alias: primary,
                agentRuntime: { id: "codex" },
              },
            },
            subagents: { allowAgents: ["main"] },
          },
          entries: { main: {} },
        },
      } as unknown as OpenClawConfig);

      await expectAgents([expectedAgent(model, agentRuntime)]);
    },
  );

  it("does not advertise stale allowlist-only targets as spawnable agents", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        entries: { main: { subagents: { allowAgents: ["stale"] } } },
      },
    } satisfies OpenClawConfig);

    await expectAgents([]);
  });

  it("returns requester as the only target when no subagent allowlist is configured", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: { model: "openai/gpt-5.6-sol" },
        entries: { main: {}, codex: {} },
      },
    } satisfies OpenClawConfig);

    await expectAgents([expectedAgent("openai/gpt-5.6-sol", { id: "codex", source: "implicit" })]);
  });

  it("uses the persisted fixed-store owner for a bare requester key", async () => {
    loadConfigMock.mockReturnValue({
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });

    const result = await createAgentsListTool({ agentSessionKey: "global" }).execute("call", {});

    expect(result.details).toMatchObject({
      requester: "ops",
      agents: [{ id: "ops", configured: true }],
    });
  });
});
