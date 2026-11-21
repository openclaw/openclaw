import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentsListTool } from "./agents-list-tool.js";

const loadConfigMock = vi.fn<() => OpenClawConfig>();
type AgentsConfig = NonNullable<OpenClawConfig["agents"]>;
function configureAgents(
  defaults: AgentsConfig["defaults"],
  entries: AgentsConfig["entries"] = { main: {} },
) {
  loadConfigMock.mockReturnValue({ agents: { defaults, entries } });
}

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
    configureAgents(
      { model: "anthropic/claude-opus-4.5", subagents: { allowAgents: ["codex"] } },
      {
        main: {},
        codex: {
          name: "Codex",
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    );

    const tool = createAgentsListTool({ agentSessionKey: "agent:main:main" });
    expect(tool.outputSchema).toMatchObject({
      type: "object",
      required: ["requester", "allowAny", "agents"],
    });
    await expectAgents(
      [expectedAgent("openai/gpt-5.5", { id: "codex", source: "model" }, "codex", "Codex")],
      tool,
    );
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
      configureAgents({
        model: { primary },
        models: {
          "openai/gpt-5.6-sol": {
            alias: primary,
            agentRuntime: { id: "codex" },
          },
        },
        subagents: { allowAgents: ["main"] },
      });

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

  it("names agents by configured name, then identity name", async () => {
    configureAgents(
      { model: "openai/gpt-5.6-sol", subagents: { allowAgents: ["*"] } },
      {
        main: { identity: { name: "Nova" } },
        codex: { name: "Codex", identity: { name: "Ignored" } },
      },
    );

    const tool = createAgentsListTool({ agentSessionKey: "agent:main:main" });
    expect((await tool.execute("call", {})).details).toMatchObject({
      agents: [
        { id: "main", name: "Nova" },
        { id: "codex", name: "Codex" },
      ],
    });
  });

  it("returns requester as the only target when no subagent allowlist is configured", async () => {
    configureAgents({ model: "openai/gpt-5.6-sol" }, { main: {}, codex: {} });

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
