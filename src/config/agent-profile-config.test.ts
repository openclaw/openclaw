// Covers the Agent Profile config surface.
import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("agent profile config surface", () => {
  it.each(["openclaw/base", "openclaw/small", "auto"])(
    "accepts %s on agent defaults",
    (agentProfileId) => {
      expect(AgentDefaultsSchema.safeParse({ agentProfileId }).success).toBe(true);
    },
  );

  it("accepts a known model size class and rejects an unknown one", () => {
    const models = (modelSizeClass: string) => ({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:8080/v1",
          models: [{ id: "m", name: "m", modelSizeClass }],
        },
      },
    });
    expect(ModelsConfigSchema.safeParse(models("small")).success).toBe(true);
    expect(ModelsConfigSchema.safeParse(models("huge")).success).toBe(false);
  });
});
