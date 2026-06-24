/** Tests SecretRef materialization for per-agent exec environments. */
import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime per-agent exec env", () => {
  it("resolves each configured exec env SecretRef into the active snapshot", async () => {
    const sourceConfig = asConfig({
      agents: {
        list: [
          {
            id: "referrals",
            tools: {
              exec: {
                inheritHostEnv: false,
                env: {
                  GREENHOUSE_TOKEN: {
                    source: "env",
                    provider: "default",
                    id: "REFERRALS_GREENHOUSE_TOKEN",
                  },
                },
              },
            },
          },
        ],
      },
    });
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: sourceConfig,
      env: { REFERRALS_GREENHOUSE_TOKEN: "gh-scoped-token" },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.agents?.list?.[0]?.tools?.exec?.env?.GREENHOUSE_TOKEN).toBe(
      "gh-scoped-token",
    );
    expect(sourceConfig.agents?.list?.[0]?.tools?.exec?.env?.GREENHOUSE_TOKEN).toEqual({
      source: "env",
      provider: "default",
      id: "REFERRALS_GREENHOUSE_TOKEN",
    });
  });

  it("fails atomically when an active exec env SecretRef is unresolved", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: {
            list: [
              {
                id: "referrals",
                tools: {
                  exec: {
                    env: {
                      GREENHOUSE_TOKEN: {
                        source: "env",
                        provider: "default",
                        id: "MISSING_REFERRALS_GREENHOUSE_TOKEN",
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
        env: {},
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      }),
    ).rejects.toThrow(/MISSING_REFERRALS_GREENHOUSE_TOKEN/);
  });

  it("does not resolve agent exec env refs that are inactive on a fixed node host", async () => {
    const ref = {
      source: "env" as const,
      provider: "default",
      id: "NODE_HOST_ONLY_TOKEN",
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: { exec: { host: "node" } },
        agents: {
          list: [{ id: "remote", tools: { exec: { env: { NODE_TOKEN: ref } } } }],
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.agents?.list?.[0]?.tools?.exec?.env?.NODE_TOKEN).toEqual(ref);
  });
});
