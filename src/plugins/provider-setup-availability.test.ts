import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectAvailableSetupProviderIds } from "./provider-setup-availability.js";

const resolvePluginMetadataSnapshotAsync = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn());
const enablePluginInConfig = vi.hoisted(() => vi.fn());
const enablePluginWithCapabilityConsent = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCoreAsync = vi.hoisted(() => vi.fn());
const debug = vi.hoisted(() => vi.fn());

// mock-isolation: The fixture supplies the inventory instead of discovering installed plugins.
vi.mock("./plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshotAsync,
}));

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

vi.mock("./enable.js", () => ({
  enablePluginInConfig,
  enablePluginWithCapabilityConsent,
}));

// mock-isolation: The fixture supplies setup providers without loading plugin instances.
vi.mock("./providers.runtime.js", () => ({
  resolvePluginProvidersCoreAsync,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug }),
}));

describe("detectAvailableSetupProviderIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "ollama",
        providerId: "ollama",
        methodId: "local",
        choiceId: "ollama",
        choiceLabel: "Ollama",
        appGuidedDiscovery: true,
        assistantVisibility: "detected-only",
      },
    ]);
    enablePluginInConfig.mockImplementation((config: unknown) => ({
      config,
      enabled: true,
      pluginId: "ollama",
    }));
    enablePluginWithCapabilityConsent.mockImplementation(enablePluginInConfig);
  });

  it("does not execute a discovery runtime that needs capability consent", async () => {
    const config = { plugins: { entries: { ollama: { enabled: false } } } };
    enablePluginWithCapabilityConsent.mockResolvedValueOnce({
      config,
      enabled: false,
      pluginId: "ollama",
      reason: "Plugin requires capability consent.",
    });
    resolvePluginProvidersCoreAsync.mockResolvedValue([]);

    await expect(detectAvailableSetupProviderIds({ config })).resolves.toEqual(new Set());

    expect(resolvePluginProvidersCoreAsync).not.toHaveBeenCalled();
    expect(config.plugins.entries.ollama.enabled).toBe(false);
  });

  it("returns the provider id when its read-only availability probe succeeds", async () => {
    const detectAvailability = vi.fn(async () => true);
    resolvePluginProvidersCoreAsync.mockResolvedValue([
      {
        pluginId: "ollama",
        id: "ollama",
        auth: [{ id: "local", appGuidedSetup: { detectAvailability } }],
      },
    ]);

    await expect(detectAvailableSetupProviderIds({ config: {} })).resolves.toEqual(
      new Set(["ollama"]),
    );
    expect(detectAvailability).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      workspaceDir: undefined,
    });
  });

  it("loads providers from the inventory that selected their choices", async () => {
    const metadataSnapshot = { manifestRegistry: { plugins: [] } };
    resolvePluginMetadataSnapshotAsync.mockResolvedValue(metadataSnapshot);
    resolvePluginProvidersCoreAsync.mockResolvedValue([]);

    await detectAvailableSetupProviderIds({ config: {}, workspaceDir: "/workspace" });

    expect(resolvePluginMetadataSnapshotAsync).toHaveBeenCalledOnce();
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot, workspaceDir: "/workspace" }),
    );
    expect(resolvePluginProvidersCoreAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "setup",
        onlyPluginIds: ["ollama"],
        pluginMetadataSnapshot: metadataSnapshot,
        workspaceDir: "/workspace",
      }),
    );
  });

  it("treats failed availability probes as an intentional non-match", async () => {
    resolvePluginProvidersCoreAsync.mockResolvedValue([
      {
        pluginId: "ollama",
        id: "ollama",
        auth: [
          {
            id: "local",
            appGuidedSetup: {
              detectAvailability: vi.fn(async () => {
                throw new Error("offline");
              }),
            },
          },
        ],
      },
    ]);

    await expect(detectAvailableSetupProviderIds({ config: {} })).resolves.toEqual(new Set());
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
