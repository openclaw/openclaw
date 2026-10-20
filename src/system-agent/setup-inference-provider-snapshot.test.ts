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
    const replacement = {
      baseUrl: "https://replacement.example/v1",
      api: "openai-responses",
      models: [{ id: "gpt-5.4-mini", name: "Sparse saved model" }],
      ...(request ? { request } : {}),
    };
    const sparse = validateConfigObjectRaw({
      ...configured,
      models: { providers: { openai: replacement } },
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

    expect(result).toMatchObject({ ok: true });
    expect(setup.readProfile()).toEqual([saved.profile.profileId, credential]);
    const snapshot = await readConfigFileSnapshot();
    for (const [providers, unrelated] of [
      [setup.run.mock.calls[0]?.[0].config?.models?.providers, unrelatedRuntimeProvider],
      [snapshot.sourceConfig.models?.providers, unrelatedProvider],
    ] as const) {
      expect(providers?.openai).toMatchObject({
        baseUrl: replacement.baseUrl,
        apiKey: saved.profile.profileId,
      });
      expect(providers?.openai?.request).toEqual(request);
      expect(providers?.openai?.headers).toBeUndefined();
      expect(providers?.unrelated).toEqual(unrelated);
    }
    expect(snapshot.sourceConfig.models?.providers?.openai?.models).toEqual(replacement.models);
  },
);
