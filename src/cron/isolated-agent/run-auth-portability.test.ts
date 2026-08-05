import { describe, expect, it } from "vitest";
import { resolveScheduledOpenClawAuthPortabilityError } from "./run-auth-portability.js";

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("scheduled OpenClaw auth portability", () => {
  it("accepts platform API keys and ChatGPT JWT credentials", () => {
    expect(
      resolveScheduledOpenClawAuthPortabilityError({
        provider: "openai",
        profileId: "openai:key",
        credential: { type: "api_key", provider: "openai", key: "secret" },
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledOpenClawAuthPortabilityError({
        provider: "openai",
        profileId: "openai:chatgpt",
        credential: { type: "token", provider: "openai", token: jwt({ sub: "user" }) },
      }),
    ).toBeUndefined();
  });

  it("rejects known opaque Codex tokens without exposing them", () => {
    const error = resolveScheduledOpenClawAuthPortabilityError({
      provider: "openai",
      profileId: "openai:codex-cli",
      credential: { type: "token", provider: "openai", token: "opaque-secret-token" },
    });

    expect(error).toContain("openclaw models auth login --provider openai");
    expect(error).not.toContain("opaque-secret-token");
  });
});
