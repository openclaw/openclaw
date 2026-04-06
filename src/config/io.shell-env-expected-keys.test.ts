import { describe, expect, it, vi } from "vitest";

const listKnownProviderAuthEnvVarNames = vi.hoisted(() => vi.fn(() => ["OPENAI_API_KEY"]));

vi.mock("../secrets/provider-env-vars.js", () => ({
  listKnownProviderAuthEnvVarNames,
}));

describe("config io shell env expected keys", () => {
  it("includes provider auth env vars from manifest-driven provider metadata", async () => {
    listKnownProviderAuthEnvVarNames.mockReturnValueOnce([
      "OPENAI_API_KEY",
      "ARCEEAI_API_KEY",
      "FIREWORKS_ALT_API_KEY",
    ]);

    vi.resetModules();
    const { resolveShellEnvExpectedKeys } = await import("./io.js");

    expect(resolveShellEnvExpectedKeys({} as NodeJS.ProcessEnv)).toEqual(
      expect.arrayContaining([
        "OPENAI_API_KEY",
        "ARCEEAI_API_KEY",
        "FIREWORKS_ALT_API_KEY",
        "OPENCLAW_GATEWAY_TOKEN",
        "SLACK_BOT_TOKEN",
      ]),
    );
  });
});
