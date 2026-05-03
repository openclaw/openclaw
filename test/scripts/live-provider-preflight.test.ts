import { describe, expect, it } from "vitest";
import {
  parseProviders,
  planLiveProviderPreflight,
} from "../../scripts/github/live-provider-preflight.mjs";

describe("scripts/github/live-provider-preflight.mjs", () => {
  it("normalizes requested live model providers", () => {
    expect(parseProviders("OpenAI, z.ai opencode open-router")).toEqual([
      "openai",
      "zai",
      "opencode-go",
      "openrouter",
    ]);
  });

  it("skips stable live lanes with machine-readable missing credential details", () => {
    const plan = planLiveProviderPreflight({
      env: {
        OPENCLAW_LIVE_PROVIDERS: "openai",
        RELEASE_TEST_PROFILE: "stable",
      },
      laneId: "live-models-targeted",
    });

    expect(plan).toMatchObject({
      laneId: "live-models-targeted",
      profile: "stable",
      providers: ["openai"],
      shouldRun: false,
      status: "skipped",
      strict: false,
      missingCredentials: [{ provider: "openai", expectedEnv: ["OPENAI_API_KEY"] }],
    });
  });

  it("fails full live lanes when selected provider credentials are absent", () => {
    const plan = planLiveProviderPreflight({
      env: {
        OPENCLAW_LIVE_PROVIDERS: "openai",
        RELEASE_TEST_PROFILE: "full",
      },
    });
    expect(plan.status).toBe("failed");
    expect(plan.shouldRun).toBe(false);
    expect(plan.strict).toBe(true);
  });

  it("runs when at least one accepted credential exists for each provider", () => {
    const plan = planLiveProviderPreflight({
      env: {
        OPENCLAW_LIVE_PROVIDERS: "openai anthropic",
        RELEASE_TEST_PROFILE: "stable",
        OPENAI_API_KEY: "test",
        ANTHROPIC_API_TOKEN: "test",
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.shouldRun).toBe(true);
    expect(plan.missingCredentials).toEqual([]);
  });
});
