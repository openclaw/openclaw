/** Tests clone isolation for active web-tool metadata state. */
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime.js";
import { createEmptyRuntimeWebToolsMetadata } from "./runtime-fast-path.js";
import type { WebToolsMetadataProvenance } from "./runtime-state.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  getActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function activeSearchProvider(): string | undefined {
  return getActiveRuntimeWebToolsMetadata()?.search.selectedProvider;
}

function populatedSearchMetadata(provider: string): RuntimeWebToolsMetadata {
  return {
    search: {
      providerConfigured: provider,
      providerSource: "configured",
      selectedProvider: provider,
      selectedProviderKeySource: "secretRef",
      diagnostics: [],
    },
    fetch: {
      providerSource: "none",
      diagnostics: [],
    },
    diagnostics: [],
  };
}

function preparedSnapshot(params: {
  sourceConfig: OpenClawConfig;
  webTools?: RuntimeWebToolsMetadata;
  webToolsProvenance: WebToolsMetadataProvenance;
}): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: params.sourceConfig,
    config: structuredClone(params.sourceConfig),
    authStores: [],
    warnings: [],
    webTools: params.webTools ?? createEmptyRuntimeWebToolsMetadata(),
    webToolsProvenance: params.webToolsProvenance,
  };
}

describe("runtime web tools state", () => {
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearActiveRuntimeWebToolsMetadata();
  });

  it("exposes active runtime web tool metadata as a defensive clone", () => {
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerConfigured: "gemini",
        providerSource: "configured",
        selectedProvider: "gemini",
        selectedProviderKeySource: "secretRef",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });

    const first = getActiveRuntimeWebToolsMetadata();
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    expect(first.search.providerConfigured).toBe("gemini");
    expect(first.search.selectedProvider).toBe("gemini");
    expect(first.search.selectedProviderKeySource).toBe("secretRef");
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadata();
    if (!second) {
      throw new Error("missing cloned runtime web tools metadata");
    }
    expect(second.search.providerConfigured).toBe("gemini");
    expect(second.search.selectedProvider).toBe("gemini");
  });

  function activateResolvedBraveSearch(): void {
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({
          tools: {
            web: {
              search: { provider: "brave" },
            },
          },
        }),
        webTools: populatedSearchMetadata("brave"),
        webToolsProvenance: "resolved",
      }),
    );
  }

  it("preserves populated web metadata across repeated stripped fast-path refreshes", () => {
    activateResolvedBraveSearch();

    // A writer's stripped refresh re-prepares the active snapshot from a partial
    // config view; provenance marks it stripped so prior metadata survives.
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsProvenance: "stripped-refresh",
      }),
    );
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsProvenance: "stripped-refresh",
      }),
    );

    expect(activeSearchProvider()).toBe("brave");
  });

  it("clears web metadata when a canonical fast-path config deletes web surfaces", () => {
    activateResolvedBraveSearch();

    // P1: a genuine web-config deletion fast-paths to an empty no-container config
    // identical in shape to a stripped refresh. Provenance keeps it authoritative
    // so the deleted web tools clear instead of leaving stale `web_search` active.
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsProvenance: "canonical-fast-path",
      }),
    );

    expect(activeSearchProvider()).toBeUndefined();
  });

  it("clears web metadata when a real canonical prepare of an empty config runs", async () => {
    activateResolvedBraveSearch();

    // P1 end-to-end: the real prepare path must assign `canonical-fast-path` to a
    // fresh empty config so deleting web config clears active web metadata.
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");
    const deleted = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-web-tools-state"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    expect(deleted.webToolsProvenance).toBe("canonical-fast-path");

    activateSecretsRuntimeSnapshot(deleted);
    expect(activeSearchProvider()).toBeUndefined();
  });

  it("preserves web metadata when a stripped refresh carries an unrelated plugin entry", () => {
    activateResolvedBraveSearch();

    // P1: an unrelated `plugins.entries` write must not clear web tools. Preservation
    // is provenance-gated, not container-gated, so a stripped refresh whose config
    // only touches an unrelated plugin entry still keeps the active web metadata.
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({
          plugins: {
            entries: {
              "unrelated-plugin": { config: { someUnrelatedSetting: true } },
            },
          },
        }),
        webToolsProvenance: "stripped-refresh",
      }),
    );

    expect(activeSearchProvider()).toBe("brave");
  });

  it("clears web metadata when the full resolver returns empty metadata", () => {
    activateResolvedBraveSearch();

    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsProvenance: "resolved",
      }),
    );

    expect(activeSearchProvider()).toBeUndefined();
  });
});
