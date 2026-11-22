// Covers the Agent Profile config surface: the profile owns context serialization.
import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent profile config surface", () => {
  it("accepts agentProfileId on agent defaults", () => {
    expect(AgentDefaultsSchema.safeParse({ agentProfileId: "auto" }).success).toBe(true);
  });

  it("does not expose a standalone contextSerialization key on agent defaults", () => {
    expect(AgentDefaultsSchema.safeParse({ contextSerialization: "compact" }).success).toBe(false);
  });
});
