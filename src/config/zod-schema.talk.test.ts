import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema Talk provider selection", () => {
  it("preserves a selected realtime provider and its instructions", () => {
    const realtime = {
      provider: "openai",
      providers: {
        openai: { model: "gpt-realtime", speakerVoice: "alloy", speakerVoiceId: "voice-123" },
      },
      instructions: "Speak with crisp diction.",
      consultRouting: "force-agent-consult",
    };
    expect(OpenClawSchema.parse({ talk: { realtime } }).talk?.realtime).toEqual(realtime);
  });

  it.each(["talk", "realtime"])("rejects inherited provider keys in %s", (scope) => {
    const selection = {
      provider: "constructor",
      providers: { elevenlabs: { voiceId: "voice-123" } },
    };
    const talk = scope === "talk" ? selection : { realtime: selection };
    const result = OpenClawSchema.safeParse({ talk });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(
      scope === "talk" ? ["talk", "provider"] : ["talk", "realtime", "provider"],
    );
  });

  it("requires an explicit selection when multiple providers are configured", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          providers: { acme: { voiceId: "voice-acme" }, elevenlabs: { voiceId: "voice-eleven" } },
        },
      }),
    ).toThrow(/talk\.provider|required/i);
  });
});
