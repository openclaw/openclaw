// Covers runtime snapshot writes produced by config IO.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  projectConfigOntoPairedRuntimeSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
} from "./io.js";
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
    const provider = independentConfig.models?.providers?.openai;
    if (provider) {
      provider.apiKey = "sk-independent-config"; // pragma: allowlist secret
    }

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    expect(projectConfigOntoRuntimeSourceSnapshot(independentConfig)).toBe(independentConfig);
  });

  it("rejects a stale resolved SecretRef value while preserving scoped patches", () => {
    const sourceConfig = createSourceConfig();
    const runtimeConfig = createRuntimeConfig();
    const scopedConfig = structuredClone(runtimeConfig);
    scopedConfig.tools = { alsoAllow: ["brokered_action"] };

    expect(
      projectConfigOntoPairedRuntimeSourceSnapshot({
        config: scopedConfig,
        runtimeConfig,
        sourceConfig,
      }),
    ).toEqual({
      ...sourceConfig,
      tools: { alsoAllow: ["brokered_action"] },
    });

    const staleConfig = structuredClone(scopedConfig);
    const provider = staleConfig.models?.providers?.openai;
    if (provider) {
      provider.apiKey = "sk-stale-runtime"; // pragma: allowlist secret
    }
    expect(
      projectConfigOntoPairedRuntimeSourceSnapshot({
        config: staleConfig,
        runtimeConfig,
        sourceConfig,
      }),
    ).toBeUndefined();
  });

  it("preserves SecretRefs when an unrelated top-level branch is removed", () => {
    const sourceConfig = { ...createSourceConfig(), tools: { allow: ["brokered_action"] } };
    const runtimeConfig = { ...createRuntimeConfig(), tools: { allow: ["brokered_action"] } };
    const scopedConfig = structuredClone(runtimeConfig);
    delete scopedConfig.tools;

    expect(
      projectConfigOntoPairedRuntimeSourceSnapshot({
        config: scopedConfig,
        runtimeConfig,
        sourceConfig,
      }),
    ).toEqual(createSourceConfig());
  });

  it("preserves SecretRefs when a scoped patch changes an array sibling", () => {
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
    const scopedConfig = structuredClone(runtimeConfig);
    const scopedAccounts = (
      scopedConfig.plugins?.entries?.brokered?.config as {
        accounts: Array<{ apiKey: unknown; label: string }>;
      }
    ).accounts;
    scopedAccounts[0]!.label = "scoped";

    const projected = projectConfigOntoPairedRuntimeSourceSnapshot({
      config: scopedConfig,
      runtimeConfig,
      sourceConfig,
    });

    expect(
      (
        projected?.plugins?.entries?.brokered?.config as {
          accounts: Array<{ apiKey: unknown; label: string }>;
        }
      ).accounts[0],
    ).toEqual({ apiKey: secretRef, label: "scoped" });
  });
});
