import { beforeEach, expect, it, vi } from "vitest";
import { detectAvailableSetupProviderIds } from "./provider-setup-availability.js";

const loadManifestMetadataSnapshot = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn());
const enablePluginInConfig = vi.hoisted(() => vi.fn());
const enablePluginWithCapabilityConsent = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn());
const debug = vi.hoisted(() => vi.fn());

// mock-isolation: The fixture supplies the inventory instead of discovering installed plugins.
vi.mock("./manifest-contract-eligibility.js", () => ({ loadManifestMetadataSnapshot }));
// mock-isolation: Auth choices come from the synthetic setup inventory, not installed providers.
vi.mock("./provider-auth-choices.js", () => ({ resolveManifestProviderAuthChoices }));
// mock-isolation: Simulate capability consent without persisting plugin configuration changes.
vi.mock("./enable.js", () => ({ enablePluginInConfig, enablePluginWithCapabilityConsent }));
// mock-isolation: Availability probes use controlled providers without loading runtime integrations.
vi.mock("./providers.runtime.js", () => ({ resolvePluginProvidersCore }));
// mock-isolation: Capture diagnostic output without initializing the process logger.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ debug }) }));

const metadataSnapshot = { manifestRegistry: { plugins: [] } };
beforeEach(() => {
  vi.clearAllMocks();
  loadManifestMetadataSnapshot.mockReturnValue(metadataSnapshot);
  resolveManifestProviderAuthChoices.mockReturnValue([
    {
      pluginId: "ollama",
      providerId: "ollama",
      methodId: "local",
      choiceId: "ollama",
      appGuidedDiscovery: true,
      assistantVisibility: "detected-only",
    },
  ]);
  enablePluginInConfig.mockImplementation((config: unknown) => ({
    config,
    enabled: true,
  }));
  enablePluginWithCapabilityConsent.mockImplementation(enablePluginInConfig);
});

it("does not execute a discovery runtime that needs capability consent", async () => {
  const config = { plugins: { entries: { ollama: { enabled: false } } } };
  enablePluginWithCapabilityConsent.mockResolvedValueOnce({
    config,
    enabled: false,
  });
  resolvePluginProvidersCore.mockReturnValue([]);
  await expect(detectAvailableSetupProviderIds({ config })).resolves.toEqual(new Set());
  expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  expect(config.plugins.entries.ollama.enabled).toBe(false);
});

it.each(["available", "missing", "failed"] as const)(
  "uses the selecting inventory and handles a %s availability probe",
  async (state) => {
    const detectAvailability = vi.fn(async () => {
      if (state === "failed") {
        throw new Error("offline");
      }
      return true;
    });
    resolvePluginProvidersCore.mockReturnValue(
      state === "missing"
        ? []
        : [
            {
              pluginId: "ollama",
              id: "ollama",
              auth: [{ id: "local", appGuidedSetup: { detectAvailability } }],
            },
          ],
    );
    const workspaceDir = "/workspace";
    await expect(detectAvailableSetupProviderIds({ config: {}, workspaceDir })).resolves.toEqual(
      new Set(state === "available" ? ["ollama"] : []),
    );
    expect(loadManifestMetadataSnapshot).toHaveBeenCalledOnce();
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot, workspaceDir }),
    );
    expect(resolvePluginProvidersCore).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "setup",
        onlyPluginIds: ["ollama"],
        pluginMetadataSnapshot: metadataSnapshot,
        workspaceDir,
      }),
    );
    if (state !== "missing") {
      expect(detectAvailability).toHaveBeenCalledWith({
        config: {},
        env: process.env,
        workspaceDir,
      });
    }
    if (state === "failed") {
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("offline"));
    }
  },
);
