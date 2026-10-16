import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeNativeSessionCatalogPreferences } from "../../../plugins/native-session-catalog-config.js";

const loadInstalledPluginIndexInstallRecords = vi.hoisted(() => vi.fn(async () => ({})));
const hasBundledPluginStartupManifest = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords,
}));
vi.mock("../../../plugins/bundled-plugin-startup-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/bundled-plugin-startup-metadata.js")>()),
  hasBundledPluginStartupManifest,
}));

const { configMayRequireStartupPluginConvergence, planStartupPluginConvergence } =
  await import("./startup-plugin-convergence-plan.js");

describe("startup plugin convergence planning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    hasBundledPluginStartupManifest.mockReturnValue(false);
  });

  it("keeps a freshly initialized catalog opt-out out of plugin convergence", async () => {
    const config = initializeNativeSessionCatalogPreferences({ gateway: { mode: "local" } });
    await expect(planStartupPluginConvergence({ config, env: {} })).resolves.toEqual({
      required: false,
      installRecords: {},
    });
  });

  it("retains convergence for explicit plugin and runtime configuration", () => {
    expect(
      configMayRequireStartupPluginConvergence({
        config: { plugins: { entries: { example: { enabled: true } } } },
        env: {},
      }),
    ).toBe(true);
    expect(
      configMayRequireStartupPluginConvergence({
        config: { acp: { enabled: true } },
        env: {},
      }),
    ).toBe(true);
  });

  it("does not infer plugin work from core OpenAI model configuration", () => {
    expect(
      configMayRequireStartupPluginConvergence({
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-responses",
                models: [],
              },
            },
          },
        },
        env: { OPENAI_API_KEY: "redacted" },
      }),
    ).toBe(false);
  });

  it("retains convergence for official external provider configuration", () => {
    expect(
      configMayRequireStartupPluginConvergence({
        config: { agents: { defaults: { model: { primary: "groq/llama-3.3-70b" } } } },
        env: {},
      }),
    ).toBe(true);
  });
});
