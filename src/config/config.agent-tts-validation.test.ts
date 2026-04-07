import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.ts";

describe("agent tts schema", () => {
  it("accepts agents.list[].tts overrides", () => {
    const result = validateConfigObjectRaw({
      agents: {
        list: [
          {
            id: "eva",
            tts: {
              provider: "openai",
              providers: {
                openai: {
                  voice: "ash",
                },
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
  });
});
