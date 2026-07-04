// Covers runtime snapshot writes produced by config IO.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMergePatchToPairedRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
} from "./io.js";
import { getRuntimeConfigSourcePair } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

function createSourceConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          models: [],
        },
      },
    },
  };
}

function createRuntimeConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-runtime-resolved", // pragma: allowlist secret
          models: [],
        },
      },
    },
  };
}

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime config snapshot writes", () => {
  beforeEach(() => {
    resetRuntimeConfigState();
  });

  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("skips source projection for non-runtime-derived configs", () => {
    const sourceConfig: OpenClawConfig = {
      ...createSourceConfig(),
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      ...createRuntimeConfig(),
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const independentConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-independent-config", // pragma: allowlist secret
            models: [],
          },
        },
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const projected = projectConfigOntoRuntimeSourceSnapshot(independentConfig);
    expect(projected).toBe(independentConfig);
  });

  it("does not pair a same-shape literal config with the active SecretRef source", () => {
    const sourceConfig = createSourceConfig();
    const runtimeConfig = createRuntimeConfig();
    const independentConfig = createRuntimeConfig();

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    expect(projectConfigOntoRuntimeSourceSnapshot(independentConfig)).toBe(independentConfig);
    expect(getRuntimeConfigSourcePair(independentConfig)).toBeUndefined();
  });

  it("pairs a known scoped merge but rejects changed SecretRef values", () => {
    const sourceConfig = createSourceConfig();
    const runtimeConfig = createRuntimeConfig();
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const scopedConfig = applyMergePatchToPairedRuntimeConfig({
      runtimeConfig,
      patch: { tools: { alsoAllow: ["brokered_action"] } },
    });
    expect(scopedConfig).toEqual({
      ...runtimeConfig,
      tools: { alsoAllow: ["brokered_action"] },
    });
    expect(getRuntimeConfigSourcePair(scopedConfig)).toEqual({
      ...sourceConfig,
      tools: { alsoAllow: ["brokered_action"] },
    });

    expect(() =>
      applyMergePatchToPairedRuntimeConfig({
        runtimeConfig,
        patch: {
          models: {
            providers: {
              openai: {
                apiKey: "sk-stale-runtime", // pragma: allowlist secret
                models: [],
              },
            },
          },
        },
      }),
    ).toThrow("Cannot override a resolved SecretRef");
  });

  it("preserves SecretRefs when an unrelated top-level branch is removed", () => {
    const sourceConfig = { ...createSourceConfig(), tools: { allow: ["brokered_action"] } };
    const runtimeConfig = { ...createRuntimeConfig(), tools: { allow: ["brokered_action"] } };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const scopedConfig = applyMergePatchToPairedRuntimeConfig({
      runtimeConfig,
      patch: { tools: null } as unknown as OpenClawConfig,
    });

    expect(getRuntimeConfigSourcePair(scopedConfig)).toEqual(createSourceConfig());
  });

  it("preserves SecretRefs when a scoped patch carries an unchanged array credential", () => {
    const secretRef = { source: "env", provider: "default", id: "ACCOUNT_API_KEY" } as const;
    const sourceConfig = {
      plugins: {
        entries: {
          brokered: {
            config: { accounts: [{ apiKey: secretRef, label: "primary" }] },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = structuredClone(sourceConfig);
    const runtimeAccounts = (
      runtimeConfig.plugins?.entries?.brokered?.config as {
        accounts: Array<{ apiKey: unknown; label: string }>;
      }
    ).accounts;
    runtimeAccounts[0]!.apiKey = "resolved-secret";
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const scopedConfig = applyMergePatchToPairedRuntimeConfig({
      runtimeConfig,
      patch: {
        plugins: {
          entries: {
            brokered: {
              config: { accounts: [{ apiKey: "resolved-secret", label: "scoped" }] },
            },
          },
        },
      },
    });

    expect(
      (
        getRuntimeConfigSourcePair(scopedConfig)?.plugins?.entries?.brokered?.config as {
          accounts: Array<{ apiKey: unknown; label: string }>;
        }
      ).accounts[0],
    ).toEqual({ apiKey: secretRef, label: "scoped" });
  });
});
