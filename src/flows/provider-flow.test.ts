import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveManifestProviderSetupFlowContributions,
  resolveProviderModelPickerFlowContributions,
} from "./provider-flow.js";

const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
const resolveProviderWizardOptions = vi.hoisted(() => vi.fn(() => []));
const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderWizardOptions,
  resolveProviderModelPickerEntries,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders,
}));

describe("provider flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses bundled compat when resolving docs for manifest-backed setup contributions", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "sglang",
        providerId: "sglang",
        methodId: "custom",
        choiceId: "provider-plugin:sglang:custom",
        choiceLabel: "SGLang",
      },
    ]);
    resolvePluginProviders.mockReturnValue([{ id: "sglang", docsPath: "/providers/sglang" }]);

    const contributions = resolveManifestProviderSetupFlowContributions({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    });
    expect(contributions[0]?.option.docs).toEqual({ path: "/providers/sglang" });
  });

  it("uses bundled compat when resolving docs for runtime model-picker contributions", () => {
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        value: "provider-plugin:vllm:custom",
        label: "vLLM",
      },
    ]);
    resolvePluginProviders.mockReturnValue([{ id: "vllm", docsPath: "/providers/vllm" }]);

    const contributions = resolveProviderModelPickerFlowContributions({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    });
    expect(contributions[0]?.option.docs).toEqual({ path: "/providers/vllm" });
  });
});
