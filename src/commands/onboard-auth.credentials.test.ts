import { afterEach, describe, expect, it } from "vitest";
import {
  setByteplusApiKey,
  setCloudflareAiGatewayConfig,
  setMoonshotApiKey,
  setOpenaiApiKey,
  setVolcengineApiKey,
} from "./onboard-auth.js";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("onboard auth credentials secret refs", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "MOONSHOT_API_KEY",
    "OPENAI_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "VOLCANO_ENGINE_API_KEY",
    "BYTEPLUS_API_KEY",
  ]);

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  type AuthProfileEntry = { key?: string; keyRef?: unknown; metadata?: unknown };

  async function withAuthEnv(
    prefix: string,
    run: (env: Awaited<ReturnType<typeof setupAuthTestEnv>>) => Promise<void>,
  ) {
    const env = await setupAuthTestEnv(prefix);
    lifecycle.setStateDir(env.stateDir);
    await run(env);
  }

  async function readProfile(
    agentDir: string,
    profileId: string,
  ): Promise<AuthProfileEntry | undefined> {
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, AuthProfileEntry>;
    }>(agentDir);
    return parsed.profiles?.[profileId];
  }

  async function expectStoredAuthKey(params: {
    prefix: string;
    envVar?: string;
    envValue?: string;
    profileId: string;
    apply: (agentDir: string) => Promise<void>;
    expected: AuthProfileEntry;
    absent?: Array<keyof AuthProfileEntry>;
  }) {
    await withAuthEnv(params.prefix, async (env) => {
      if (params.envVar && params.envValue !== undefined) {
        process.env[params.envVar] = params.envValue;
      }
      await params.apply(env.agentDir);
      const profile = await readProfile(env.agentDir, params.profileId);
      expect(profile).toMatchObject(params.expected);
      for (const key of params.absent ?? []) {
        expect(profile?.[key]).toBeUndefined();
      }
    });
  }

  it("keeps env-backed moonshot key as plaintext by default", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-",
      envVar: "MOONSHOT_API_KEY",
      envValue: "sk-moonshot-env",
      profileId: "moonshot:default",
      apply: async () => {
        await setMoonshotApiKey("sk-moonshot-env");
      },
      expected: {
        key: "sk-moonshot-env",
      },
      absent: ["keyRef"],
    });
  });

  it("stores env-backed moonshot key as keyRef when secret-input-mode=ref", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-ref-",
      envVar: "MOONSHOT_API_KEY",
      envValue: "sk-moonshot-env",
      profileId: "moonshot:default",
      apply: async (agentDir) => {
        await setMoonshotApiKey("sk-moonshot-env", agentDir, { secretInputMode: "ref" });
      },
      expected: {
        keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
      },
      absent: ["key"],
    });
  });

  it("stores ${ENV} moonshot input as keyRef even when env value is unset", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-inline-ref-",
      profileId: "moonshot:default",
      apply: async () => {
        await setMoonshotApiKey("${MOONSHOT_API_KEY}");
      },
      expected: {
        keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
      },
      absent: ["key"],
    });
  });

  it("keeps plaintext moonshot key when no env ref applies", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-plaintext-",
      envVar: "MOONSHOT_API_KEY",
      envValue: "sk-moonshot-other",
      profileId: "moonshot:default",
      apply: async () => {
        await setMoonshotApiKey("sk-moonshot-plaintext");
      },
      expected: {
        key: "sk-moonshot-plaintext",
      },
      absent: ["keyRef"],
    });
  });

  it("preserves cloudflare metadata when storing keyRef", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-cloudflare-");
    lifecycle.setStateDir(env.stateDir);
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "cf-secret";

    await setCloudflareAiGatewayConfig("account-1", "gateway-1", "cf-secret", env.agentDir, {
      secretInputMode: "ref",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown; metadata?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
      metadata: { accountId: "account-1", gatewayId: "gateway-1" },
    });
    expect(parsed.profiles?.["cloudflare-ai-gateway:default"]?.key).toBeUndefined();
  });

  it("keeps env-backed openai key as plaintext by default", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-openai-",
      envVar: "OPENAI_API_KEY",
      envValue: "sk-openai-env",
      profileId: "openai:default",
      apply: async () => {
        await setOpenaiApiKey("sk-openai-env");
      },
      expected: {
        key: "sk-openai-env",
      },
      absent: ["keyRef"],
    });
  });

  it("stores env-backed openai key as keyRef in ref mode", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-openai-ref-",
      envVar: "OPENAI_API_KEY",
      envValue: "sk-openai-env",
      profileId: "openai:default",
      apply: async (agentDir) => {
        await setOpenaiApiKey("sk-openai-env", agentDir, { secretInputMode: "ref" });
      },
      expected: {
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      absent: ["key"],
    });
  });

  it("stores env-backed volcengine and byteplus keys as keyRef in ref mode", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-volc-byte-");
    lifecycle.setStateDir(env.stateDir);
    process.env.VOLCANO_ENGINE_API_KEY = "volcengine-secret";
    process.env.BYTEPLUS_API_KEY = "byteplus-secret";

    await setVolcengineApiKey("volcengine-secret", env.agentDir, { secretInputMode: "ref" });
    await setByteplusApiKey("byteplus-secret", env.agentDir, { secretInputMode: "ref" });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);

    expect(parsed.profiles?.["volcengine:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
    });
    expect(parsed.profiles?.["volcengine:default"]?.key).toBeUndefined();

    expect(parsed.profiles?.["byteplus:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
    });
    expect(parsed.profiles?.["byteplus:default"]?.key).toBeUndefined();
  });
});
