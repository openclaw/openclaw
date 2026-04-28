import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runSearchSetupFlow } from "./search-setup.js";

const mockGrokProvider = vi.hoisted(() => ({
  id: "grok",
  pluginId: "xai",
  label: "Grok",
  hint: "Search with xAI",
  docsUrl: "https://docs.openclaw.ai/tools/web",
  requiresCredential: true,
  credentialLabel: "xAI API key",
  placeholder: "xai-...",
  signupUrl: "https://x.ai/api",
  envVars: ["XAI_API_KEY"],
  onboardingScopes: ["text-inference"],
  credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
  getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => {
    searchConfigTarget.apiKey = value;
  },
  getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | {
            entries?: Record<
              string,
              {
                config?: {
                  webSearch?: { apiKey?: unknown };
                };
              }
            >;
          }
        | undefined
    )?.entries?.xai?.config?.webSearch?.apiKey,
  setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
    const plugins = (configTarget.plugins ??= {}) as Record<string, unknown>;
    const entries = (plugins.entries ??= {}) as Record<string, unknown>;
    const xaiEntry = (entries.xai ??= {}) as Record<string, unknown>;
    const xaiConfig = (xaiEntry.config ??= {}) as Record<string, unknown>;
    const webSearch = (xaiConfig.webSearch ??= {}) as Record<string, unknown>;
    webSearch.apiKey = value;
  },
  runSetup: async ({
    config,
    prompter,
  }: {
    config: Record<string, unknown>;
    prompter: { select: (params: Record<string, unknown>) => Promise<string> };
  }) => {
    const enableXSearch = await prompter.select({
      message: "Enable x_search",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    });
    if (enableXSearch !== "yes") {
      return config;
    }
    const model = await prompter.select({
      message: "Grok model",
      options: [{ value: "grok-4-1-fast", label: "grok-4-1-fast" }],
    });
    const pluginEntries = (config.plugins as { entries?: Record<string, unknown> } | undefined)
      ?.entries;
    const existingXaiEntry = pluginEntries?.xai as Record<string, unknown> | undefined;
    const existingXaiConfig = (
      pluginEntries?.xai as { config?: Record<string, unknown> } | undefined
    )?.config;
    return {
      ...config,
      plugins: {
        ...(config.plugins as Record<string, unknown> | undefined),
        entries: {
          ...pluginEntries,
          xai: {
            ...existingXaiEntry,
            config: {
              ...existingXaiConfig,
              xSearch: {
                enabled: true,
                model,
              },
            },
          },
        },
      },
    };
  },
}));

const mockResolveWebSearchProviders = vi.hoisted(() => vi.fn());

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: mockResolveWebSearchProviders,
}));

describe("runSearchSetupFlow", () => {
  beforeEach(() => {
    mockResolveWebSearchProviders.mockReturnValue([mockGrokProvider]);
  });

  it("runs provider-owned setup after selecting Grok web search", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const text = vi.fn().mockResolvedValue("xai-test-key");
    const prompter = createWizardPrompter({
      select: select as never,
      text: text as never,
    });

    const next = await runSearchSetupFlow(
      { plugins: { allow: ["xai"] } },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.plugins?.entries?.xai?.config?.webSearch).toMatchObject({
      apiKey: "xai-test-key",
    });
    expect(next.tools?.web?.search).toMatchObject({
      provider: "grok",
      enabled: true,
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });

  it("preserves disabled web_search state while still allowing provider-owned x_search setup", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const prompter = createWizardPrompter({
      select: select as never,
    });

    const next = await runSearchSetupFlow(
      {
        plugins: {
          allow: ["xai"],
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
              enabled: false,
            },
          },
        },
      },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.tools?.web?.search).toMatchObject({
      provider: "grok",
      enabled: false,
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });
});

const mockSearxngProvider = {
  id: "searxng",
  pluginId: "searxng",
  label: "SearXNG Search",
  hint: "Self-hosted meta-search with no API key required",
  onboardingScopes: ["text-inference"] as const,
  requiresCredential: true,
  credentialLabel: "SearXNG Base URL",
  envVars: ["SEARXNG_BASE_URL"],
  placeholder: "http://localhost:8080",
  signupUrl: "https://docs.searxng.org/",
  credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
  credentialNote: [
    "For the SearXNG JSON API to work, make sure your SearXNG instance",
    "has the json format enabled in its settings.yml under search.formats.",
  ].join("\n"),
  getCredentialValue: (search?: Record<string, unknown>) => search?.baseUrl,
  setCredentialValue: (target: Record<string, unknown>, value: unknown) => {
    target.baseUrl = value;
  },
  getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | { entries?: { searxng?: { config?: { webSearch?: { baseUrl?: unknown } } } } }
        | undefined
    )?.entries?.searxng?.config?.webSearch?.baseUrl,
  setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
    const plugins = (configTarget.plugins ??= {}) as Record<string, unknown>;
    const entries = (plugins.entries ??= {}) as Record<string, unknown>;
    const entry = (entries.searxng ??= {}) as Record<string, unknown>;
    const cfg = (entry.config ??= {}) as Record<string, unknown>;
    const webSearch = (cfg.webSearch ??= {}) as Record<string, unknown>;
    webSearch.baseUrl = value;
  },
  createTool: () => null,
};

describe("runSearchSetupFlow — SearXNG credentialNote", () => {
  beforeEach(() => {
    mockResolveWebSearchProviders.mockReturnValue([mockSearxngProvider]);
  });

  it("shows JSON format note before plaintext URL entry", async () => {
    const noteMessages: string[] = [];
    const prompter = createWizardPrompter({
      select: vi.fn().mockResolvedValue("searxng") as never,
      text: vi.fn().mockResolvedValue("http://search.local:8080") as never,
      note: vi.fn(async (msg: string) => {
        noteMessages.push(msg);
      }) as never,
    });

    await runSearchSetupFlow({} as never, createNonExitingRuntime(), prompter);

    const credentialNoteIndex = noteMessages.findIndex((m) => m.includes("search.formats"));
    const textCallOrder = (prompter.text as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const noteCallOrder = (prompter.note as ReturnType<typeof vi.fn>).mock.results.map(
      (_, i) => (prompter.note as ReturnType<typeof vi.fn>).mock.invocationCallOrder[i],
    )[credentialNoteIndex];

    expect(credentialNoteIndex).toBeGreaterThanOrEqual(0);
    expect(noteCallOrder).toBeLessThan(textCallOrder);
  });

  it("shows JSON format note before secretRef note when secretInputMode is ref", async () => {
    const noteMessages: string[] = [];
    const prompter = createWizardPrompter({
      select: vi.fn().mockResolvedValue("searxng") as never,
      note: vi.fn(async (msg: string) => {
        noteMessages.push(msg);
      }) as never,
    });

    await runSearchSetupFlow({} as never, createNonExitingRuntime(), prompter, {
      secretInputMode: "ref",
    });

    const credentialNoteIndex = noteMessages.findIndex((m) => m.includes("search.formats"));
    const secretRefNoteIndex = noteMessages.findIndex((m) =>
      m.includes("Secret references enabled"),
    );

    expect(credentialNoteIndex).toBeGreaterThanOrEqual(0);
    expect(secretRefNoteIndex).toBeGreaterThan(credentialNoteIndex);
  });

  it("skips JSON format note in quickstart fast path when URL is already configured", async () => {
    const noteMessages: string[] = [];
    const prompter = createWizardPrompter({
      select: vi.fn().mockResolvedValue("searxng") as never,
      note: vi.fn(async (msg: string) => {
        noteMessages.push(msg);
      }) as never,
    });

    const configWithUrl = {
      plugins: {
        entries: {
          searxng: { config: { webSearch: { baseUrl: "http://search.local:8080" } } },
        },
      },
    };

    await runSearchSetupFlow(configWithUrl as never, createNonExitingRuntime(), prompter, {
      quickstartDefaults: true,
    });

    expect(noteMessages.some((m) => m.includes("search.formats"))).toBe(false);
  });
});
