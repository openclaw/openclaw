import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  credential,
  fixture,
  modelRef,
  tempDirs,
} from "./setup-inference-activate.test-support.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  clearConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { label: "default auth", request: undefined },
  {
    label: "replacement header auth",
    request: {
      auth: { mode: "header" as const, headerName: "X-New-Key", value: "replacement-key" },
    },
  },
])(
  "activates saved sparse provider settings with $label without reviving old auth",
  async ({ request }) => {
    const setup = await fixture();
    const configured = structuredClone(setup.config);
    assert(configured.agents?.defaults);
    configured.agents.defaults.model = `${modelRef}@openai:original`;
    assert(configured.models?.providers?.openai);
    configured.models.providers.openai.request = {
      auth: { mode: "header", headerName: "X-Old-Key", value: "original-key" },
      headers: { "X-Old-Request-Key": "original-request-key" },
    };
    configured.models.providers.openai.headers = {
      "X-Old-Provider-Key": "original-provider-key",
    };
    const unrelatedProvider = {
      ...structuredClone(configured.models.providers.openai),
      baseUrl: "https://unrelated.example/v1",
    };
    configured.models.providers.unrelated = unrelatedProvider;
    await persistProviderAuthProfilesAfterLogin({
      config: configured,
      agentDir: setup.agentDir,
      profiles: [
        { profileId: "openai:original", credential: { ...credential, key: "original-key" } },
      ],
    });
    await fs.writeFile(setup.configPath, JSON.stringify(configured));
    clearConfigCache();
    const unrelatedRuntimeProvider = structuredClone(
      (await readConfigFileSnapshot()).config.models?.providers?.unrelated,
    );
    const sparse = validateConfigObjectRaw({
      ...configured,
      models: {
        providers: {
          openai: {
            baseUrl: "https://replacement.example/v1",
            api: "openai-responses",
            models: [{ id: "gpt-5.4-mini", name: "Sparse saved model" }],
            ...(request ? { request } : {}),
          },
        },
      },
    });
    assert.ok(sparse.ok);
    const saved = await saveSetupCredential({
      profile: { profileId: "openai:replacement", credential },
      config: sparse.config,
      baseConfig: configured,
      agentDir: setup.agentDir,
      modelRef,
      authChoice: "fixture-login",
      pluginId: "openai",
    });

    const result = await setup.activate(
      `saved-auth:${encodeURIComponent(saved.profile.profileId)}`,
      true,
    );

    const verifiedProviders = setup.run.mock.calls[0]?.[0].config?.models?.providers;
    expect(verifiedProviders?.openai?.baseUrl).toBe("https://replacement.example/v1");
    expect(verifiedProviders?.openai?.apiKey).toBe(saved.profile.profileId);
    expect(verifiedProviders?.openai?.request).toEqual(request);
    expect(verifiedProviders?.openai?.headers).toBeUndefined();
    expect(verifiedProviders?.unrelated).toEqual(unrelatedRuntimeProvider);
    expect(result).toMatchObject({ ok: true });
    expect(setup.readProfile()).toEqual([saved.profile.profileId, credential]);
    const snapshot = await readConfigFileSnapshot();
    expect(snapshot.sourceConfig.models?.providers?.openai?.baseUrl).toBe(
      "https://replacement.example/v1",
    );
    expect(snapshot.sourceConfig.models?.providers?.openai?.request).toEqual(request);
    expect(snapshot.sourceConfig.models?.providers?.openai?.apiKey).toBe(saved.profile.profileId);
    expect(snapshot.sourceConfig.models?.providers?.openai?.headers).toBeUndefined();
    expect(snapshot.sourceConfig.models?.providers?.unrelated).toEqual(unrelatedProvider);
    expect(snapshot.sourceConfig.models?.providers?.openai?.models).toEqual([
      { id: "gpt-5.4-mini", name: "Sparse saved model" },
    ]);
  },
);
