// A worker turn runs the profile the Gateway selected from the configuration.
import { describe, expect, it } from "vitest";
import { resolveWorkerTurnAgentProfile } from "./worker-turn-agent-profile.js";

const model = { primary: "anthropic/claude-opus-4-1" };
const turn = {
  agentId: "main",
  sessionKey: "agent:main:main",
  config: { agents: { defaults: { model } } },
};

describe("resolveWorkerTurnAgentProfile", () => {
  it("selects the base profile when no profile is configured", () => {
    const resolved = resolveWorkerTurnAgentProfile({ turn });
    expect(resolved.profile.id).toBe("openclaw/base");
    expect(resolved.selectionSource).toBe("fallback");
  });

  it("selects the configured small profile", () => {
    const resolved = resolveWorkerTurnAgentProfile({
      turn: {
        ...turn,
        config: { agents: { defaults: { model, agentProfileId: "openclaw/small" as const } } },
      },
    });
    expect(resolved.profile.id).toBe("openclaw/small");
    expect(resolved.selectionSource).toBe("defaults-explicit");
  });
});
