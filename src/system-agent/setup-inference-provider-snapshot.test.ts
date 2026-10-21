import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { credential, fixture, modelRef } from "./setup-inference-activate.test-support.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";
import { resetSetupInferenceState } from "./setup-inference-state.test-support.js";

afterEach(resetSetupInferenceState);

it.each([
  undefined,
  { auth: { mode: "header" as const, headerName: "X-New-Key", value: "replacement-key" } },
])("replaces saved provider settings without reviving old auth (%j)", async (request) => {
  const setup = await fixture();
  const configured = structuredClone(setup.config);
  assert(configured.agents?.defaults);
  configured.agents.defaults.model = `${modelRef}@openai:original`;
  assert(configured.models?.providers?.openai);
  const original = configured.models.providers.openai;
  original.request = {
    auth: { mode: "header", headerName: "X-Old-Key", value: "original-key" },
    headers: { "X-Old-Request-Key": "original-request-key" },
  };
  original.headers = {
    "X-Old-Provider-Key": "original-provider-key",
  };
  const unrelatedProvider = {
    ...structuredClone(original),
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

  const profileId = saved.profile.profileId;
  const result = await setup.activate(`saved-auth:${encodeURIComponent(profileId)}`, true);

  expect(result).toMatchObject({ ok: true });
  expect(setup.readProfile()).toEqual([profileId, credential]);
  const snapshot = await readConfigFileSnapshot();
  for (const [providers, unrelated] of [
    [setup.run.mock.calls[0]?.[0].config?.models?.providers, unrelatedRuntimeProvider],
    [snapshot.sourceConfig.models?.providers, unrelatedProvider],
  ] as const) {
    expect(providers?.openai).toMatchObject({
      baseUrl: replacement.baseUrl,
      apiKey: profileId,
    });
    expect(providers?.openai?.request).toEqual(request);
    expect(providers?.openai?.headers).toBeUndefined();
    expect(providers?.unrelated).toEqual(unrelated);
  }
  expect(snapshot.sourceConfig.models?.providers?.openai?.models).toEqual(replacement.models);
});
