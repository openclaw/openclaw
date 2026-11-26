import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { signInNeedsApiKeyForVoice } from "./voice-sign-in-policy.js";

const oauth = {
  type: "oauth" as const,
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: Date.now() + 60_000,
};
const store = (profiles: AuthProfileStore["profiles"]): AuthProfileStore => ({
  version: 1,
  profiles,
});

describe("signInNeedsApiKeyForVoice", () => {
  it("names Sign in with ChatGPT, which OpenAI's policy refuses for voice", () => {
    const siwc = store({ "openai:me": { ...oauth, authFlow: "chatgpt-token-sharing" } });
    expect(signInNeedsApiKeyForVoice(siwc, "openai")).toBe(true);
  });

  it("leaves Codex OAuth, which can transcribe, and API keys alone", () => {
    expect(signInNeedsApiKeyForVoice(store({ "openai:codex": oauth }), "openai")).toBe(false);
    expect(
      signInNeedsApiKeyForVoice(
        store({ "openai:key": { type: "api_key", provider: "openai", key: "synthetic-key" } }),
        "openai",
      ),
    ).toBe(false);
  });
});
