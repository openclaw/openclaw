// Covers the Agent Profile config surface.
import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent profile config surface", () => {
  it.each(["openclaw/base", "openclaw/small"])("accepts %s on agent defaults", (agentProfileId) => {
    expect(AgentDefaultsSchema.safeParse({ agentProfileId }).success).toBe(true);
  });

  it("rejects a selector that is not a registered profile", () => {
    expect(AgentDefaultsSchema.safeParse({ agentProfileId: "auto" }).success).toBe(false);
  });
});
