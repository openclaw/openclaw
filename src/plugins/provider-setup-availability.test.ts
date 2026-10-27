import { beforeEach, expect, it, vi } from "vitest";
import { detectAvailableSetupProviderIds } from "./provider-setup-availability.js";

const loadManifestMetadataSnapshot = vi.hoisted(() =>
  vi.fn(() => ({ manifestRegistry: { plugins: [] } })),
);
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn());
const enablePluginInConfig = vi.hoisted(() => vi.fn());
const enablePluginWithCapabilityConsent = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn(() => []));

// mock-isolation: The fixture supplies the inventory instead of discovering installed plugins.
vi.mock("./manifest-contract-eligibility.js", () => ({ loadManifestMetadataSnapshot }));
// mock-isolation: Auth choices come from the synthetic setup inventory, not installed providers.
vi.mock("./provider-auth-choices.js", () => ({ resolveManifestProviderAuthChoices }));
// mock-isolation: Simulate capability consent without persisting plugin configuration changes.
vi.mock("./enable.js", () => ({ enablePluginInConfig, enablePluginWithCapabilityConsent }));
// mock-isolation: Availability probes use controlled providers without loading runtime integrations.
vi.mock("./providers.runtime.js", () => ({ resolvePluginProvidersCore }));

beforeEach(() => {
  vi.clearAllMocks();
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
  enablePluginInConfig.mockImplementation((config: unknown) => ({ config, enabled: true }));
  enablePluginWithCapabilityConsent.mockImplementation(enablePluginInConfig);
});

it("does not execute a discovery runtime that needs capability consent", async () => {
  const config = { plugins: { entries: { ollama: { enabled: false } } } };
  enablePluginWithCapabilityConsent.mockResolvedValueOnce({ config, enabled: false });
  await expect(detectAvailableSetupProviderIds({ config })).resolves.toEqual(new Set());
  expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  expect(config.plugins.entries.ollama.enabled).toBe(false);
});

it("omits a setup choice whose runtime provider is missing", async () => {
  await expect(detectAvailableSetupProviderIds({ config: {} })).resolves.toEqual(new Set());
  expect(resolvePluginProvidersCore).toHaveBeenCalledOnce();
});
