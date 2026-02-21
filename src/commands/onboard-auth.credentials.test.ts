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

  it("keeps env-backed moonshot key as plaintext by default", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-");
    lifecycle.setStateDir(env.stateDir);
    process.env.MOONSHOT_API_KEY = "sk-moonshot-env";

    await setMoonshotApiKey("sk-moonshot-env");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["moonshot:default"]).toMatchObject({
      key: "sk-moonshot-env",
    });
    expect(parsed.profiles?.["moonshot:default"]?.keyRef).toBeUndefined();
  });

  it("stores env-backed moonshot key as keyRef in ref mode", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-ref-");
    lifecycle.setStateDir(env.stateDir);
    process.env.MOONSHOT_API_KEY = "sk-moonshot-env";

    await setMoonshotApiKey("sk-moonshot-env", env.agentDir, { secretInputMode: "ref" });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["moonshot:default"]).toMatchObject({
      keyRef: { source: "env", id: "MOONSHOT_API_KEY" },
    });
    expect(parsed.profiles?.["moonshot:default"]?.key).toBeUndefined();
  });

  it("stores ${ENV} moonshot input as keyRef even when env value is unset", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-inline-ref-");
    lifecycle.setStateDir(env.stateDir);

    await setMoonshotApiKey("${MOONSHOT_API_KEY}");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["moonshot:default"]).toMatchObject({
      keyRef: { source: "env", id: "MOONSHOT_API_KEY" },
    });
    expect(parsed.profiles?.["moonshot:default"]?.key).toBeUndefined();
  });

  it("keeps plaintext moonshot key when no env ref applies", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-plaintext-");
    lifecycle.setStateDir(env.stateDir);
    process.env.MOONSHOT_API_KEY = "sk-moonshot-other";

    await setMoonshotApiKey("sk-moonshot-plaintext");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["moonshot:default"]).toMatchObject({
      key: "sk-moonshot-plaintext",
    });
    expect(parsed.profiles?.["moonshot:default"]?.keyRef).toBeUndefined();
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
      keyRef: { source: "env", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
      metadata: { accountId: "account-1", gatewayId: "gateway-1" },
    });
    expect(parsed.profiles?.["cloudflare-ai-gateway:default"]?.key).toBeUndefined();
  });

  it("keeps env-backed openai key as plaintext by default", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-openai-");
    lifecycle.setStateDir(env.stateDir);
    process.env.OPENAI_API_KEY = "sk-openai-env";

    await setOpenaiApiKey("sk-openai-env");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["openai:default"]).toMatchObject({
      key: "sk-openai-env",
    });
    expect(parsed.profiles?.["openai:default"]?.keyRef).toBeUndefined();
  });

  it("stores env-backed openai key as keyRef in ref mode", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-openai-ref-");
    lifecycle.setStateDir(env.stateDir);
    process.env.OPENAI_API_KEY = "sk-openai-env";

    await setOpenaiApiKey("sk-openai-env", env.agentDir, { secretInputMode: "ref" });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["openai:default"]).toMatchObject({
      keyRef: { source: "env", id: "OPENAI_API_KEY" },
    });
    expect(parsed.profiles?.["openai:default"]?.key).toBeUndefined();
  });

  it("stores env-backed volcengine and byteplus keys as keyRef", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-volc-byte-");
    lifecycle.setStateDir(env.stateDir);
    process.env.VOLCANO_ENGINE_API_KEY = "volcengine-secret";
    process.env.BYTEPLUS_API_KEY = "byteplus-secret";

    await setVolcengineApiKey("volcengine-secret");
    await setByteplusApiKey("byteplus-secret");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);

    expect(parsed.profiles?.["volcengine:default"]).toMatchObject({
      keyRef: { source: "env", id: "VOLCANO_ENGINE_API_KEY" },
    });
    expect(parsed.profiles?.["volcengine:default"]?.key).toBeUndefined();

    expect(parsed.profiles?.["byteplus:default"]).toMatchObject({
      keyRef: { source: "env", id: "BYTEPLUS_API_KEY" },
    });
    expect(parsed.profiles?.["byteplus:default"]?.key).toBeUndefined();
  });
});
