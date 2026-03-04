import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema memory.sessions.sanitization", () => {
  it("accepts transcript session-memory sanitization config", () => {
    const parsed = OpenClawSchema.parse({
      memory: {
        sessions: {
          sanitization: {
            enabled: true,
            model: { primary: "openai/gpt-5-mini" },
            thinking: "low",
            rawMaxAge: "24h",
          },
        },
      },
    });

    expect(parsed.memory?.sessions?.sanitization?.enabled).toBe(true);
    expect(parsed.memory?.sessions?.sanitization?.model).toEqual({
      primary: "openai/gpt-5-mini",
    });
    expect(parsed.memory?.sessions?.sanitization?.thinking).toBe("low");
    expect(parsed.memory?.sessions?.sanitization?.rawMaxAge).toBe("24h");
  });
});
