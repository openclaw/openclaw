import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertApiKeyProfile } from "../plugins/provider-auth-helpers.js";
import { captureEnv } from "../test-utils/env.js";

const providerEnvVarsById: Record<string, readonly string[]> = {
  "cloudflare-ai-gateway": ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
  byteplus: ["BYTEPLUS_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  volcengine: ["VOLCANO_ENGINE_API_KEY"],
};

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars: vi.fn((provider: string) => providerEnvVarsById[provider] ?? []),
}));

type AuthTestEnv = {
  stateDir: string;
  agentDir: string;
};

async function setupAuthTestEnv(prefix: string): Promise<AuthTestEnv> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(stateDir, "agent");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await fs.mkdir(agentDir, { recursive: true });
  return { stateDir, agentDir };
}

function createAuthTestLifecycle(envKeys: string[]) {
  const envSnapshot = captureEnv(envKeys);
  let stateDir: string | null = null;
  return {
    setStateDir(nextStateDir: string) {
      stateDir = nextStateDir;
    },
    async cleanup() {
      if (stateDir) {
        await fs.rm(stateDir, { recursive: true, force: true });
        stateDir = null;
      }
      envSnapshot.restore();
    },
  };
}

async function readAuthProfilesForAgent<T>(agentDir: string): Promise<T> {
  const raw = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8");
  return JSON.parse(raw) as T;
}

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
    "OPENCODE_API_KEY",
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

  it("keeps env-backed provider keys as plaintext by default", async () => {
    await withAuthEnv("openclaw-onboard-auth-credentials-", async (env) => {
      process.env.MOONSHOT_API_KEY = "sk-moonshot-env";
      process.env.OPENAI_API_KEY = "sk-openai-env";

      upsertApiKeyProfile({
        provider: "moonshot",
        input: "sk-moonshot-env",
        agentDir: env.agentDir,
      });
      upsertApiKeyProfile({ provider: "openai", input: "sk-openai-env", agentDir: env.agentDir });

      const parsed = await readAuthProfilesForAgent<{
        profiles?: Record<string, AuthProfileEntry>;
      }>(env.agentDir);
      expect(parsed.profiles?.["moonshot:default"]).toMatchObject({ key: "sk-moonshot-env" });
      expect(parsed.profiles?.["moonshot:default"]?.keyRef).toBeUndefined();
      expect(parsed.profiles?.["openai:default"]).toMatchObject({ key: "sk-openai-env" });
      expect(parsed.profiles?.["openai:default"]?.keyRef).toBeUndefined();
    });
  });

  it("stores env-backed provider keys as keyRef in ref mode", async () => {
    await withAuthEnv("openclaw-onboard-auth-credentials-ref-", async (env) => {
      process.env.MOONSHOT_API_KEY = "sk-moonshot-env";
      process.env.OPENAI_API_KEY = "sk-openai-env";

      upsertApiKeyProfile({
        provider: "moonshot",
        input: "sk-moonshot-env",
        agentDir: env.agentDir,
        options: { secretInputMode: "ref" }, // pragma: allowlist secret
      });
      upsertApiKeyProfile({
        provider: "openai",
        input: "sk-openai-env",
        agentDir: env.agentDir,
        options: { secretInputMode: "ref" }, // pragma: allowlist secret
      });

      const parsed = await readAuthProfilesForAgent<{
        profiles?: Record<string, AuthProfileEntry>;
      }>(env.agentDir);
      expect(parsed.profiles?.["moonshot:default"]).toMatchObject({
        keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
      });
      expect(parsed.profiles?.["moonshot:default"]?.key).toBeUndefined();
      expect(parsed.profiles?.["openai:default"]).toMatchObject({
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      });
      expect(parsed.profiles?.["openai:default"]?.key).toBeUndefined();
    });
  });

  it("stores ${ENV} moonshot input as keyRef even when env value is unset", async () => {
    await expectStoredAuthKey({
      prefix: "openclaw-onboard-auth-credentials-inline-ref-",
      profileId: "moonshot:default",
      apply: async () => {
        upsertApiKeyProfile({ provider: "moonshot", input: "${MOONSHOT_API_KEY}" });
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
        upsertApiKeyProfile({ provider: "moonshot", input: "sk-moonshot-plaintext" });
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
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "cf-secret"; // pragma: allowlist secret

    upsertApiKeyProfile({
      provider: "cloudflare-ai-gateway",
      input: "cf-secret",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // pragma: allowlist secret
      metadata: {
        accountId: "account-1",
        gatewayId: "gateway-1",
      },
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

  it("stores env-backed volcengine and byteplus keys as keyRef in ref mode", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-volc-byte-");
    lifecycle.setStateDir(env.stateDir);
    process.env.VOLCANO_ENGINE_API_KEY = "volcengine-secret"; // pragma: allowlist secret
    process.env.BYTEPLUS_API_KEY = "byteplus-secret"; // pragma: allowlist secret

    upsertApiKeyProfile({
      provider: "volcengine",
      input: "volcengine-secret",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // pragma: allowlist secret
    });
    upsertApiKeyProfile({
      provider: "byteplus",
      input: "byteplus-secret",
      agentDir: env.agentDir,
      options: { secretInputMode: "ref" }, // pragma: allowlist secret
    });

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

  it("stores shared OpenCode credentials for both runtime providers", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-opencode-");
    lifecycle.setStateDir(env.stateDir);
    process.env.OPENCODE_API_KEY = "sk-opencode-env"; // pragma: allowlist secret

    for (const provider of ["opencode", "opencode-go"] as const) {
      upsertApiKeyProfile({
        provider,
        input: "sk-opencode-env",
        agentDir: env.agentDir,
        options: { secretInputMode: "ref" }, // pragma: allowlist secret
      });
    }

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(env.agentDir);

    expect(parsed.profiles?.["opencode:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "OPENCODE_API_KEY" },
    });
    expect(parsed.profiles?.["opencode-go:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "OPENCODE_API_KEY" },
    });
  });
});
