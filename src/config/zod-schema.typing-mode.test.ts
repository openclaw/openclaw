import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { SessionSchema } from "./zod-schema.session.js";

describe("typing mode schema reuse", () => {
  it("accepts supported typingMode values for session and agent defaults", () => {
    expect(() => SessionSchema.parse({ typingMode: "thinking" })).not.toThrow();
    expect(() => AgentDefaultsSchema.parse({ typingMode: "message" })).not.toThrow();
  });

  it("rejects unsupported typingMode values for session and agent defaults", () => {
    expect(() => SessionSchema.parse({ typingMode: "always" })).toThrow();
    expect(() => AgentDefaultsSchema.parse({ typingMode: "soon" })).toThrow();
  });
});
