import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
// Onboard auth tests cover provider auth setup, credential persistence, and auth-profile state.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "../../test/helpers/auth-wizard.js";
import { ensureAuthProfileStoreAsync } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredentials } from "../llm/utils/oauth/types.js";
import {
  upsertApiKeyProfileAsync,
  writeOAuthCredentials,
} from "../plugins/provider-auth-helpers.js";
import { setTestEnvValue } from "../test-utils/env.js";

const providerEnvVarsById = vi.hoisted((): Record<string, readonly string[]> => ({
  moonshot: ["MOONSHOT_API_KEY"],
  openai: ["OPENAI_API_KEY"],
}));

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  resolveStateDir: () => process.env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

// mock-isolation: Auth onboarding uses fixture provider IDs without loading plugin alias metadata.
vi.mock("../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: vi.fn((provider: string) => provider.trim().toLowerCase()),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVarsCore: vi.fn((provider: string) => providerEnvVarsById[provider] ?? []),
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

const requireRecord = createRequireRecord("object", "expected-label");

function expectFields(value: unknown, expected: Record<string, unknown>, label = "record") {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
  return record;
}

function readEffectiveAuthProfiles(agentDir: string) {
  return ensureAuthProfileStoreAsync(agentDir, {
    readOnly: true,
    syncExternalCli: false,
  });
}

function oauthCredentials(suffix: string): OAuthCredentials {
  return { refresh: `refresh-${suffix}`, access: `access-${suffix}`, expires: Date.now() + 60_000 };
}

describe("writeOAuthCredentials", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_OAUTH_DIR",
  ]);

  afterEach(lifecycle.cleanup);

  async function setupAgents(external = false) {
    const env = await setupAuthTestEnv("openclaw-oauth-");
    lifecycle.track(env);
    const root = path.join(env.stateDir, ...(external ? ["external", "agents"] : ["agents"]));
    const main = path.join(root, "main", "agent");
    const kid = path.join(root, "kid", "agent");
    const worker = path.join(root, "worker", "agent");
    await Promise.all([main, kid, worker].map((dir) => fs.mkdir(dir, { recursive: true })));
    return { stateDir: env.stateDir, main, kid, worker };
  }

  it("persists primary and main OAuth rows while later siblings inherit", async () => {
    const { stateDir, main, kid, worker } = await setupAgents();
    setTestEnvValue("OPENCLAW_AGENT_DIR", kid);

    const readdir = fsSync.readdirSync;
    const discovery = vi.spyOn(fsSync, "readdirSync").mockImplementation((...args) => {
      const entries = readdir(...args);
      if (args[0] === path.join(stateDir, "agents")) {
        // The shared owner must precede siblings even when the filesystem lists it last.
        entries.sort(
          (left, right) =>
            Number(left.name.toString() === "kid") - Number(right.name.toString() === "kid"),
        );
      }
      return entries;
    });
    try {
      await writeOAuthCredentials("openai", oauthCredentials("sync"), undefined, {
        syncSiblingAgents: true,
      });
    } finally {
      discovery.mockRestore();
    }

    for (const dir of [main, kid, worker]) {
      const effectiveStore = await readEffectiveAuthProfiles(dir);
      expectFields(effectiveStore.profiles?.["openai:default"], {
        refresh: "refresh-sync",
        access: "access-sync",
        type: "oauth",
      });
    }
    const persistedSiblingStore = await readAuthProfilesForAgent<{
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    }>(worker);
    expect(persistedSiblingStore.profiles).toEqual({});
  });

  it("writes OAuth credentials only to target dir by default", async () => {
    const { main, kid } = await setupAgents();
    setTestEnvValue("OPENCLAW_AGENT_DIR", kid);
    await writeOAuthCredentials("openai", oauthCredentials("kid"), kid);
    const kidParsed = await readEffectiveAuthProfiles(kid);
    expectFields(kidParsed.profiles?.["openai:default"], {
      access: "access-kid",
      type: "oauth",
    });

    await expect(readAuthProfilesForAgent(main)).rejects.toThrow(
      "Expected SQLite auth profile store",
    );
  });

  it("syncs siblings from explicit agentDir outside OPENCLAW_STATE_DIR", async () => {
    const { stateDir, main, kid, worker } = await setupAgents(true);
    await writeOAuthCredentials("openai", oauthCredentials("ext"), kid, {
      syncSiblingAgents: true,
    });

    for (const dir of [main, kid, worker]) {
      const parsed = await readAuthProfilesForAgent<{
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      }>(dir);
      expectFields(parsed.profiles?.["openai:default"], {
        refresh: "refresh-ext",
        access: "access-ext",
        type: "oauth",
      });
    }

    const globalMain = path.join(stateDir, "agents", "main", "agent");
    await expect(readAuthProfilesForAgent(globalMain)).rejects.toThrow(
      "Expected SQLite auth profile store",
    );
  });
});

describe("upsertApiKeyProfile secret refs", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "MOONSHOT_API_KEY",
    "OPENAI_API_KEY",
  ]);

  afterEach(lifecycle.cleanup);

  async function expectProfile(
    agentDir: string,
    profileId: string,
    expected: Record<string, unknown>,
  ) {
    const parsed = await readEffectiveAuthProfiles(agentDir);
    expectFields(parsed.profiles[profileId], { type: "api_key", ...expected });
  }

  it("handles plaintext, ref mode, and inline env-ref provider keys", async () => {
    const env = await setupAuthTestEnv("openclaw-onboard-auth-credentials-");
    lifecycle.track(env);
    process.env.MOONSHOT_API_KEY = "sk-moonshot-env"; // pragma: allowlist secret
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

    for (const provider of ["moonshot", "openai"]) {
      await upsertApiKeyProfileAsync({
        provider,
        input: `sk-${provider}-env`,
        agentDir: env.agentDir,
      });
      await expectProfile(env.agentDir, `${provider}:default`, {
        key: `sk-${provider}-env`,
        keyRef: undefined,
      });
    }
    for (const provider of ["moonshot", "openai"]) {
      await upsertApiKeyProfileAsync({
        provider,
        input: `sk-${provider}-env`,
        agentDir: env.agentDir,
        options: { secretInputMode: "ref" }, // pragma: allowlist secret
      });
    }
    await upsertApiKeyProfileAsync({
      provider: "moonshot",
      input: "${MOONSHOT_API_KEY}",
      agentDir: env.agentDir,
      profileId: "moonshot:inline",
    });
    process.env.MOONSHOT_API_KEY = "sk-moonshot-other"; // pragma: allowlist secret
    await upsertApiKeyProfileAsync({
      provider: "moonshot",
      input: "sk-moonshot-plaintext",
      agentDir: env.agentDir,
      profileId: "moonshot:plain",
    });

    await expectProfile(env.agentDir, "moonshot:default", {
      keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
      key: undefined,
    });
    await expectProfile(env.agentDir, "openai:default", {
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      key: undefined,
    });
    await expectProfile(env.agentDir, "moonshot:inline", {
      keyRef: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
    });
    await expectProfile(env.agentDir, "moonshot:plain", {
      key: "sk-moonshot-plaintext",
      keyRef: undefined,
    });
  });
});
