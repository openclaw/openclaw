import { describe, expect, it } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { resolveTalkSessionAgentId } from "../../../talk/agent-target.js";

describe("default agent role materialization", () => {
  it("uses the Talk owner for unscoped aliases and explicit agent keys when present", () => {
    const config: OpenClawConfigWithLegacyRoster = {
      agents: { entries: { ops: { default: true }, research: {} } },
      talk: { agentId: "research" },
    };
    expect(resolveTalkSessionAgentId(config, "main")).toBe("research");
    expect(resolveTalkSessionAgentId(config, "global")).toBe("research");
    expect(resolveTalkSessionAgentId(config, "agent:ops:main")).toBe("ops");
  });
});
