import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "./tool-policy-diagnostic.js";

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

describe("detectSkillWorkshopToolPolicyDiagnostic", () => {
  it("reports the sandbox construction gate despite an additive grant", () => {
    const diagnostic = detect({
      agents: {
        entries: {
          main: {
            sandbox: { mode: "all" },
            tools: { profile: "minimal", alsoAllow: ["skill_workshop"] },
          },
        },
      },
    });

    expect(diagnostic).toMatchObject({ source: "agents.entries.main.sandbox.mode" });
    expect(diagnostic?.detail).toContain("sandboxed run without library-authoring authority");
    expect(diagnostic?.fix).toContain("non-sandboxed session");
    expect(diagnostic?.fix).toContain("host-granted library-authoring authority");
    expect(diagnostic?.fix).not.toContain("alsoAllow");
  });

  it("identifies inherited sandbox mode and limits non-main advice to those sessions", () => {
    const diagnostic = detect({
      agents: {
        defaults: { sandbox: { mode: "non-main" } },
        entries: { main: { tools: { profile: "minimal", alsoAllow: ["skill_workshop"] } } },
      },
    });

    expect(diagnostic).toMatchObject({ source: "agents.defaults.sandbox.mode" });
    expect(diagnostic?.detail).toContain("In non-main sessions");
    expect(diagnostic?.fix).not.toContain("alsoAllow");
  });

  it("returns no diagnostic for an included tool or an unsandboxed additive grant", () => {
    expect(detect({ tools: { profile: "coding" } })).toBeNull();
    expect(
      detect({
        agents: {
          defaults: { sandbox: { mode: "all" } },
          entries: {
            main: {
              sandbox: { mode: "off" },
              tools: { profile: "messaging", alsoAllow: ["skill_workshop"] },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("returns no diagnostic when Workshop capture is disabled", () => {
    expect(detect({ tools: { profile: "messaging" } }, false)).toBeNull();
  });

  it("names agent-scoped profile and allowlist sources", () => {
    expect(
      detect({
        agents: { entries: { main: { tools: { profile: "messaging" } } } },
      }),
    ).toMatchObject({
      source: "agents.entries.main.tools.profile",
      fix: 'Add agents.entries.main.tools.alsoAllow: ["skill_workshop"].',
    });

    expect(
      detect({
        agents: { entries: { main: { tools: { allow: ["read"] } } } },
      }),
    ).toMatchObject({
      source: "agents.entries.main.tools.allow",
      fix: 'Add "skill_workshop" to agents.entries.main.tools.allow.',
    });
  });

  it("targets the effective agent-scoped profile grant owner", () => {
    expect(
      detect({
        tools: { profile: "messaging" },
        agents: { entries: { main: { tools: { alsoAllow: ["read"] } } } },
      }),
    ).toMatchObject({
      source: "tools.profile",
      fix: 'Add agents.entries.main.tools.alsoAllow: ["skill_workshop"].',
    });
  });

  it("targets the effective agent-scoped provider profile grant owner", () => {
    expect(
      detect({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          entries: {
            main: {
              tools: { byProvider: { openai: { alsoAllow: ["read"] } } },
            },
          },
        },
        tools: { byProvider: { openai: { profile: "messaging" } } },
      }),
    ).toMatchObject({
      source: 'tools.byProvider["openai"].profile',
      fix: 'Add agents.entries.main.tools.byProvider["openai"].alsoAllow: ["skill_workshop"].',
    });
  });

  it("names the matching agent provider allowlist source", () => {
    expect(
      detect({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          entries: {
            main: {
              tools: { byProvider: { openai: { allow: ["read"] } } },
            },
          },
        },
      }),
    ).toMatchObject({
      source: 'agents.entries.main.tools.byProvider["openai"].allow',
      fix: 'Add "skill_workshop" to agents.entries.main.tools.byProvider["openai"].allow.',
    });
  });

  it.each([
    { tools: { deny: ["skill_workshop"] } },
    { tools: { profile: "minimal", deny: ["skill_*"] } },
    { tools: { byProvider: { openai: { deny: ["group:agents"] } } } },
    { agents: { entries: { main: { tools: { profile: "minimal", deny: ["group:agents"] } } } } },
    {
      agents: {
        entries: {
          main: { tools: { byProvider: { openai: { deny: ["skill_workshop"] } } } },
        },
      },
    },
    {
      agents: {
        entries: {
          main: { sandbox: { mode: "all" }, tools: { deny: ["skill_workshop"] } },
        },
      },
    },
  ] satisfies OpenClawConfig[])("treats a matching deny as an intentional opt-out: %j", (cfg) => {
    expect(
      detect({
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: { model: { primary: "openai/gpt-5.5" } },
        },
      }),
    ).toBeNull();
  });
});
