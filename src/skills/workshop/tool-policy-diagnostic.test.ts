import { describe, expect, it } from "vitest";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentToolsConfig } from "../../config/types.tools.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "./tool-policy-diagnostic.js";

const agent = (
  entry: AgentEntryConfig,
  defaults?: NonNullable<OpenClawConfig["agents"]>["defaults"],
): OpenClawConfig => ({ agents: { entries: { main: entry }, ...(defaults ? { defaults } : {}) } });
const agentTools = (tools: AgentToolsConfig) => agent({ tools });
const byProvider = (tools: NonNullable<AgentToolsConfig["byProvider"]>[string]) => ({
  byProvider: { openai: tools },
});
function withModel(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: { ...config.agents, defaults: { model: { primary: "openai/gpt-5.5" } } },
  };
}

function detect(config: OpenClawConfig, workshopEnabled = true) {
  const agents = config.agents;
  const hasRoster = Boolean(agents && "entries" in agents);
  return detectSkillWorkshopToolPolicyDiagnostic({
    config: {
      ...config,
      agents: hasRoster ? agents : { ...agents, entries: { main: {} } },
    },
    workshopEnabled,
  });
}

function expectPolicy(config: OpenClawConfig, source: string, fix: string) {
  expect(detect(config)).toMatchObject({ source, fix });
}

describe("detectSkillWorkshopToolPolicyDiagnostic", () => {
  it("reports the sandbox construction gate despite an additive grant", () => {
    const diagnostic = detect(
      agent({
        sandbox: { mode: "all" },
        tools: { profile: "minimal", alsoAllow: ["skill_workshop"] },
      }),
    );

    expect(diagnostic).toMatchObject({ source: "agents.entries.main.sandbox.mode" });
    expect(diagnostic?.detail).toContain("sandboxed run without library-authoring authority");
    expect(diagnostic?.fix).toContain("non-sandboxed session");
    expect(diagnostic?.fix).toContain("host-granted library-authoring authority");
    expect(diagnostic?.fix).not.toContain("alsoAllow");
  });

  it("identifies inherited sandbox mode and limits non-main advice to those sessions", () => {
    const diagnostic = detect(
      agent(
        { tools: { profile: "minimal", alsoAllow: ["skill_workshop"] } },
        { sandbox: { mode: "non-main" } },
      ),
    );

    expect(diagnostic).toMatchObject({ source: "agents.defaults.sandbox.mode" });
    expect(diagnostic?.detail).toContain("In non-main sessions");
    expect(diagnostic?.fix).not.toContain("alsoAllow");
  });

  it("returns no diagnostic for an included tool or an unsandboxed additive grant", () => {
    expect(detect({ tools: { profile: "coding" } })).toBeNull();
    expect(
      detect(
        agent(
          {
            sandbox: { mode: "off" },
            tools: { profile: "messaging", alsoAllow: ["skill_workshop"] },
          },
          { sandbox: { mode: "all" } },
        ),
      ),
    ).toBeNull();
  });

  it("returns no diagnostic when Workshop capture is disabled", () => {
    expect(detect({ tools: { profile: "messaging" } }, false)).toBeNull();
  });

  it("names agent-scoped profile and allowlist sources", () => {
    expectPolicy(
      agentTools({ profile: "messaging" }),
      "agents.entries.main.tools.profile",
      'Add agents.entries.main.tools.alsoAllow: ["skill_workshop"].',
    );
    expectPolicy(
      agentTools({ allow: ["read"] }),
      "agents.entries.main.tools.allow",
      'Add "skill_workshop" to agents.entries.main.tools.allow.',
    );
  });

  it("targets the effective agent-scoped profile grant owner", () => {
    expectPolicy(
      {
        tools: { profile: "messaging" },
        ...agentTools({ alsoAllow: ["read"] }),
      },
      "tools.profile",
      'Add agents.entries.main.tools.alsoAllow: ["skill_workshop"].',
    );
  });

  it("targets the effective agent-scoped provider profile grant owner", () => {
    expectPolicy(
      withModel({
        ...agentTools(byProvider({ alsoAllow: ["read"] })),
        tools: byProvider({ profile: "messaging" }),
      }),
      'tools.byProvider["openai"].profile',
      'Add agents.entries.main.tools.byProvider["openai"].alsoAllow: ["skill_workshop"].',
    );
  });

  it("names the matching agent provider allowlist source", () => {
    expectPolicy(
      withModel(agentTools(byProvider({ allow: ["read"] }))),
      'agents.entries.main.tools.byProvider["openai"].allow',
      'Add "skill_workshop" to agents.entries.main.tools.byProvider["openai"].allow.',
    );
  });

  it.each([
    { tools: { deny: ["skill_workshop"] } },
    { tools: { profile: "minimal", deny: ["skill_*"] } },
    { tools: byProvider({ deny: ["group:agents"] }) },
    agentTools({ profile: "minimal", deny: ["group:agents"] }),
    agentTools(byProvider({ deny: ["skill_workshop"] })),
    agent({ sandbox: { mode: "all" }, tools: { deny: ["skill_workshop"] } }),
  ] satisfies OpenClawConfig[])("treats a matching deny as an intentional opt-out: %j", (cfg) => {
    expect(detect(withModel(cfg))).toBeNull();
  });
});
