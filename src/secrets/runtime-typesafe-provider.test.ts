import { expect, it } from "vitest";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

it.each([true, false])(
  "prepares TypeSafe through the model-provider secret owner, available=%s",
  async (available) => {
    const ref = { source: "env", provider: "default", id: "SYNTHETIC_SYSTEM_ONE_KEY" } as const;
    const provider = {
      baseUrl: "https://decision.example.com/v1",
      models: [],
      apiKey: ref,
      headers: { "X-Server-Key": ref },
      request: {
        allowPrivateNetwork: false,
        auth: { mode: "authorization-bearer" as const, token: ref },
      },
    };
    const config = asConfig({
      plugins: { enabled: false },
      agents: { defaults: { decisionModel: "typesafe/nemotron-deciffusion" } },
      models: ModelsConfigSchema.parse({ providers: { typesafe: provider } }),
    });
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: available ? { SYNTHETIC_SYSTEM_ONE_KEY: "synthetic-prepared-key" } : {},
      agentDirs: [],
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map(),
    });
    const expected = available ? "synthetic-prepared-key" : ref;
    expect(snapshot.config.models?.providers?.typesafe).toMatchObject({
      baseUrl: "https://decision.example.com/v1",
      apiKey: expected,
      headers: { "X-Server-Key": expected },
      request: {
        allowPrivateNetwork: false,
        auth: { mode: "authorization-bearer", token: expected },
      },
    });
    expect(snapshot.sourceConfig.models?.providers?.typesafe?.apiKey).toEqual(ref);
    if (available) {
      expect(snapshot.degradedOwners ?? []).toEqual([]);
    } else {
      expect(snapshot.degradedOwners).toEqual([
        expect.objectContaining({
          ownerKind: "provider",
          ownerId: "typesafe",
          degradationState: "cold",
        }),
      ]);
    }
  },
);
