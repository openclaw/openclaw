import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertAuthProfile } from "../../agents/auth-profiles.js";
import { createAuthTestLifecycle, setupAuthTestEnv } from "../test-wizard-helpers.js";
import { resolveNonInteractiveApiKey } from "./api-keys.js";

const lifecycle = createAuthTestLifecycle([
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "GIGACHAT_CREDENTIALS",
]);

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

describe("resolveNonInteractiveApiKey", () => {
  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("skips incompatible GigaChat profiles and reuses the later personal OAuth one", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-non-interactive-api-keys-");
    lifecycle.setStateDir(env.stateDir);

    upsertAuthProfile({
      profileId: "gigachat:basic",
      agentDir: env.agentDir,
      credential: {
        type: "api_key",
        provider: "gigachat",
        key: "basic-user:basic-pass",
        metadata: {
          authMode: "basic",
          scope: "GIGACHAT_API_PERS",
        },
      },
    });
    upsertAuthProfile({
      profileId: "gigachat:business",
      agentDir: env.agentDir,
      credential: {
        type: "api_key",
        provider: "gigachat",
        key: "business-oauth-key",
        metadata: {
          authMode: "oauth",
          scope: "GIGACHAT_API_B2B",
        },
      },
    });
    upsertAuthProfile({
      profileId: "gigachat:default",
      agentDir: env.agentDir,
      credential: {
        type: "api_key",
        provider: "gigachat",
        key: "personal-oauth-key",
        metadata: {
          authMode: "oauth",
          scope: "GIGACHAT_API_PERS",
        },
      },
    });

    const resolved = await resolveNonInteractiveApiKey({
      provider: "gigachat",
      cfg: {
        auth: {
          order: {
            gigachat: ["gigachat:basic", "gigachat:business", "gigachat:default"],
          },
        },
      },
      flagName: "--gigachat-api-key",
      envVar: "GIGACHAT_CREDENTIALS",
      runtime: createRuntime() as never,
      agentDir: env.agentDir,
    });

    expect(resolved).toEqual({
      key: "personal-oauth-key",
      source: "profile",
      profileId: "gigachat:default",
      metadata: {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    });
  });
});
