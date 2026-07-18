import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadPreparedModelCatalog: vi.fn() }));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: mocks.loadPreparedModelCatalog,
}));

import { loadPreferredProviderPickerCatalog } from "./model-picker.provider-catalog.js";

describe("loadPreferredProviderPickerCatalog", () => {
  beforeEach(() => {
    mocks.loadPreparedModelCatalog.mockReset();
  });

  it("filters one committed generation by preferred provider", async () => {
    mocks.loadPreparedModelCatalog.mockResolvedValue([
      { provider: "nvidia", id: "nvidia/nemotron", name: "Nemotron" },
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    ]);

    await expect(
      loadPreferredProviderPickerCatalog({
        cfg: {},
        preferredProvider: "NVIDIA",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        env: { NVIDIA_API_KEY: "test-nvidia-api-key" },
      }),
    ).resolves.toEqual([{ provider: "nvidia", id: "nvidia/nemotron", name: "Nemotron" }]);
    expect(mocks.loadPreparedModelCatalog).toHaveBeenCalledWith({
      config: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env: { NVIDIA_API_KEY: "test-nvidia-api-key" },
    });
  });
});
