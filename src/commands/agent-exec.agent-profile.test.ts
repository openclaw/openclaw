import { describe, expect, it } from "vitest";
import { buildExecRunConfig } from "./agent-exec-input.js";

describe("agent exec Agent Profile override", () => {
  it("overrides per-agent profile selections", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: { agentProfileId: "openclaw/base" } } } },
      cwd: "/run/here",
      opts: { agentProfile: "openclaw/small" },
    });

    expect(config.agents?.defaults?.agentProfileId).toBe("openclaw/small");
    expect(config.agents?.entries?.ops?.agentProfileId).toBe("openclaw/small");
  });

  it("keeps --local-model-lean as an alias that selects openclaw/small", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: {} } } },
      cwd: "/run/here",
      opts: { localModelLean: true },
    });

    expect(config.agents?.defaults?.agentProfileId).toBe("openclaw/small");
    expect(config.agents?.entries?.ops?.agentProfileId).toBe("openclaw/small");
  });

  it("lets an explicit --agent-profile win over the --local-model-lean alias", () => {
    const config = buildExecRunConfig({
      base: {},
      cwd: "/run/here",
      opts: { localModelLean: true, agentProfile: "openclaw/base" },
    });

    expect(config.agents?.defaults?.agentProfileId).toBe("openclaw/base");
  });
});
