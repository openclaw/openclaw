import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveProviderSetupFlowContributions,
  resolveProviderModelPickerFlowContributions,
} from "./provider-flow.js";

const resolveProviderWizardOptions = vi.hoisted(() => vi.fn(() => []));
const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

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

  it("uses setup mode when resolving docs for setup contributions", () => {
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "provider-plugin:sglang:custom",
        label: "SGLang",
        groupId: "sglang",
        groupLabel: "SGLang",
      },
    ] as never);
    resolvePluginProviders.mockReturnValue([
      { id: "sglang", docsPath: "/providers/sglang" },
    ] as never);

    const contributions = resolveProviderSetupFlowContributions({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
      mode: "setup",
    });
    expect(contributions[0]?.option.docs).toEqual({ path: "/providers/sglang" });
    expect(contributions[0]?.source).toBe("runtime");
  });

  it("uses setup mode when resolving docs for runtime model-picker contributions", () => {
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        value: "provider-plugin:vllm:custom",
        label: "vLLM",
      },
    ] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm", docsPath: "/providers/vllm" }] as never);

    const contributions = resolveProviderModelPickerFlowContributions({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
      mode: "setup",
    });
    expect(contributions[0]?.option.docs).toEqual({ path: "/providers/vllm" });
  });
});
