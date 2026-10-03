import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "./tool-policy-diagnostic.js";

function detect(config: OpenClawConfig, workshopEnabled = true) {
  const agents = config.agents;
  const hasRoster = Boolean(agents && ("entries" in agents || "list" in agents));
  return detectSkillWorkshopToolPolicyDiagnostic({
    config: {
      ...config,
      agents: hasRoster ? agents : { ...agents, entries: { main: { default: true } } },
    },
    workshopEnabled,
  });
}

describe("detectSkillWorkshopToolPolicyDiagnostic", () => {
  it.each([false, true])(
    "reports the sandbox construction gate before profile advice (alsoAllow=%s)",
    (alsoAllow) => {
      const diagnostic = detect({
        agents: {
          entries: {
            main: {
              sandbox: { mode: "all" },
              tools: {
                profile: "minimal",
                ...(alsoAllow ? { alsoAllow: ["skill_workshop"] } : {}),
              },
            },
          },
        },
      });

      expect(diagnostic).toMatchObject({ source: "agents.entries.main.sandbox.mode" });
      expect(diagnostic?.detail).toContain("sandboxed run without library-authoring authority");
      expect(diagnostic?.fix).toContain("non-sandboxed session");
      expect(diagnostic?.fix).toContain("host-granted library-authoring authority");
      expect(diagnostic?.fix).not.toContain("alsoAllow");
    },
  );

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

  it("honors an agent's unsandboxed override of the inherited mode", () => {
    expect(
      detect({
        agents: {
          defaults: { sandbox: { mode: "all" } },
          entries: {
            main: {
              sandbox: { mode: "off" },
              tools: { profile: "minimal", alsoAllow: ["skill_workshop"] },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("names the profile and exact additive grant when policy excludes the tool", () => {
    expect(detect({ tools: { profile: "messaging" } })).toMatchObject({
      source: "tools.profile",
      detail: 'tools.profile: "messaging" does not include "skill_workshop".',
      fix: 'Add tools.alsoAllow: ["skill_workshop"].',
    });
  });

  it("returns no diagnostic when policy includes the tool", () => {
    expect(detect({ tools: { profile: "coding" } })).toBeNull();
    expect(detect({ tools: { profile: "messaging", alsoAllow: ["skill_workshop"] } })).toBeNull();
  });

  it("returns no diagnostic when Workshop capture is disabled", () => {
    expect(detect({ tools: { profile: "messaging" } }, false)).toBeNull();
  });

  it("names a restrictive allowlist that excludes the tool", () => {
    expect(detect({ tools: { profile: "coding", allow: ["read", "write"] } })).toMatchObject({
      source: "tools.allow",
      detail: 'tools.allow does not include "skill_workshop".',
      fix: 'Add "skill_workshop" to tools.allow.',
    });
  });

  it("names agent-scoped profile and allowlist sources", () => {
    expect(
      detect({
        agents: { list: [{ id: "main", default: true, tools: { profile: "messaging" } }] },
      }),
    ).toMatchObject({
      source: "agents.entries.main.tools.profile",
      fix: 'Add agents.entries.main.tools.alsoAllow: ["skill_workshop"].',
    });

    expect(
      detect({
        agents: { entries: { main: { default: true, tools: { allow: ["read"] } } } },
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
        agents: { entries: { main: { default: true, tools: { alsoAllow: ["read"] } } } },
      }),
    ).toMatchObject({
      source: "tools.profile",
      fix: 'Add agents.entries.main.tools.alsoAllow: ["skill_workshop"].',
    });
  });

  it("names the matching provider profile source", () => {
    expect(
      detect({
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        tools: { byProvider: { openai: { profile: "messaging" } } },
      }),
    ).toMatchObject({
      source: 'tools.byProvider["openai"].profile',
      fix: 'Add tools.byProvider["openai"].alsoAllow: ["skill_workshop"].',
    });
  });

  it("targets the effective agent-scoped provider profile grant owner", () => {
    expect(
      detect({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          entries: {
            main: {
              default: true,
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
              default: true,
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

  it("names an explicit deny and its removal", () => {
    expect(detect({ tools: { deny: ["skill_workshop"] } })).toMatchObject({
      source: "tools.deny",
      detail: 'tools.deny denies "skill_workshop".',
      fix: 'Remove the matching "skill_workshop" deny entry from tools.deny.',
    });
  });
});
