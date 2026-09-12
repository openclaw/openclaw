import { describe, expect, it } from "vitest";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import {
  listSetupInferenceAuthOptions,
  listSetupInferenceEnableOptions,
  listSetupInferenceInstallOptions,
  listSetupInferenceManualProviders,
  listSetupInferencePrepareOptions,
} from "./setup-inference-auth-options.js";
import { resolveCandidatePresentation } from "./setup-inference-core.js";

const metaEntry: ProviderInstallCatalogEntry = {
  pluginId: "meta",
  providerId: "meta",
  methodId: "api-key",
  choiceId: "meta-api-key",
  choiceLabel: "Meta API key",
  choiceHint: "Meta Responses API",
  groupId: "meta",
  groupLabel: "Meta",
  onboardingScopes: ["text-inference"],
  label: "Meta",
  origin: "bundled",
  install: { npmSpec: "@openclaw/meta-provider", defaultChoice: "npm" },
};

describe("setup inference install options", () => {
  it.each([
    ["claude-cli", "claude-cli/sonnet", "claude"],
    ["codex-cli", "openai/default", "openai"],
    ["openai-api-key", "openai/default", "openai"],
  ] as const)("presents the provider brand for %s", (kind, modelRef, brandId) => {
    expect(resolveCandidatePresentation({ kind, modelRef }, [])).toEqual({ brandId });
  });

  it("offers a provider-owned wizard without app-specific auth metadata", () => {
    expect(listSetupInferenceAuthOptions([metaEntry])).toEqual([
      expect.objectContaining({ id: "meta-api-key", kind: "install" }),
    ]);
  });
  it("surfaces uninstalled text providers as managed install choices", () => {
    expect(listSetupInferenceInstallOptions([metaEntry], [])).toEqual([
      {
        id: "meta-api-key",
        brandId: "meta",
        label: "Meta API key",
        hint: "Meta Responses API",
        groupLabel: "Meta",
        kind: "install",
        featured: false,
      },
    ]);
  });

  it("does not duplicate choices already supplied by an installed manifest", () => {
    expect(
      listSetupInferenceInstallOptions(
        [metaEntry],
        [
          {
            pluginId: "meta",
            providerId: "meta",
            methodId: "api-key",
            choiceId: "meta-api-key",
            choiceLabel: "Meta API key",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("preserves the shared presentation fields across guided setup surfaces", () => {
    const choice = {
      ...metaEntry,
      icon: "sparkles",
      website: "https://meta.example",
      appGuidedAuth: "oauth" as const,
      appGuidedSecret: true,
      appGuidedDiscovery: true,
      appGuidedActionLabel: "Connect Meta",
    };

    expect(listSetupInferenceAuthOptions([choice])).toEqual([
      {
        id: "meta-api-key",
        brandId: "meta",
        label: "Meta API key",
        hint: "Meta Responses API",
        icon: "sparkles",
        website: "https://meta.example",
        groupLabel: "Meta",
        kind: "oauth",
        featured: false,
      },
    ]);
    expect(listSetupInferenceEnableOptions([choice])[0]).toMatchObject({
      id: "meta-api-key",
      brandId: "meta",
      label: "Meta API key",
      hint: "Meta Responses API",
      icon: "sparkles",
      website: "https://meta.example",
      groupLabel: "Meta",
    });
    expect(listSetupInferenceManualProviders([choice])[0]).toMatchObject({
      id: "meta-api-key",
      brandId: "meta",
      label: "Meta API key",
      hint: "Meta Responses API",
      icon: "sparkles",
      website: "https://meta.example",
      groupLabel: "Meta",
    });
    expect(listSetupInferencePrepareOptions([choice])).toEqual([
      {
        id: "meta-api-key",
        brandId: "meta",
        label: "Meta API key",
        hint: "Meta Responses API",
        icon: "sparkles",
        website: "https://meta.example",
        actionLabel: "Connect Meta",
      },
    ]);
  });
});
