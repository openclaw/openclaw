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
const withModel = (config: OpenClawConfig): OpenClawConfig => ({
  ...config,
  agents: { ...config.agents, defaults: { model: { primary: "openai/gpt-5.5" } } },
});
const agentPath = "agents.entries.main.tools";
const providerPath = 'tools.byProvider["openai"]';
const grant = (owner: string) => `Add ${owner}.alsoAllow: ["skill_workshop"].`;
const allow = (owner: string) => `Add "skill_workshop" to ${owner}.allow.`;
const additiveGrant: AgentToolsConfig = { profile: "minimal", alsoAllow: ["skill_workshop"] };

function detect(config: OpenClawConfig, workshopEnabled = true) {
  return detectSkillWorkshopToolPolicyDiagnostic({
    config: { ...config, agents: { entries: { main: {} }, ...config.agents } },
    workshopEnabled,
  });
}

describe("detectSkillWorkshopToolPolicyDiagnostic", () => {
  it.each([
    [
      agent({ sandbox: { mode: "all" }, tools: additiveGrant }),
      "entries.main",
      "sandboxed run without library-authoring authority",
    ],
    [
      agent({ tools: additiveGrant }, { sandbox: { mode: "non-main" } }),
      "defaults",
      "In non-main sessions",
    ],
  ] as const)("reports the sandbox construction gate: %j", (config, owner, detail) => {
    const diagnostic = detect(config);
    expect(diagnostic).toMatchObject({ source: `agents.${owner}.sandbox.mode` });
    expect(diagnostic?.detail).toContain(detail);
    expect(diagnostic?.fix).toContain("non-sandboxed session");
    expect(diagnostic?.fix).toContain("host-granted library-authoring authority");
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

  it.each([
    [agentTools({ profile: "messaging" }), `${agentPath}.profile`, grant(agentPath)],
    [agentTools({ allow: ["read"] }), `${agentPath}.allow`, allow(agentPath)],
    [
      { tools: { profile: "messaging" }, ...agentTools({ alsoAllow: ["read"] }) },
      "tools.profile",
      grant(agentPath),
    ],
    [
      withModel({
        ...agentTools(byProvider({ alsoAllow: ["read"] })),
        tools: byProvider({ profile: "messaging" }),
      }),
      `${providerPath}.profile`,
      grant(`agents.entries.main.${providerPath}`),
    ],
    [
      withModel(agentTools(byProvider({ allow: ["read"] }))),
      `agents.entries.main.${providerPath}.allow`,
      allow(`agents.entries.main.${providerPath}`),
    ],
  ] satisfies [OpenClawConfig, string, string][])(
    "targets %s with source %s",
    (config, source, fix) => {
      expect(detect(config)).toMatchObject({ source, fix });
    },
  );

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
