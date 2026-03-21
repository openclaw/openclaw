import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { SEARCH_PROVIDER_OPTIONS, setupSearch } from "./onboard-search.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

function createPrompter(params: { selectValue?: string; textValue?: string }): {
  prompter: WizardPrompter;
  notes: Array<{ title?: string; message: string }>;
} {
  const notes: Array<{ title?: string; message: string }> = [];
  const prompter: WizardPrompter = {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ title, message });
    }),
    select: vi.fn(
      async () => params.selectValue ?? "perplexity",
    ) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => params.textValue ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
  return { prompter, notes };
}

function createPerplexityConfig(apiKey: string, enabled?: boolean): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "perplexity",
          ...(enabled === undefined ? {} : { enabled }),
          perplexity: { apiKey },
        },
      },
    },
  };
}

function pluginWebSearchApiKey(config: OpenClawConfig, pluginId: string): unknown {
  const entry = (
    config.plugins?.entries as
      | Record<string, { config?: { webSearch?: { apiKey?: unknown } } }>
      | undefined
  )?.[pluginId];
  return entry?.config?.webSearch?.apiKey;
}

function createDisabledFirecrawlConfig(apiKey?: string): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "firecrawl",
        },
      },
    },
    plugins: {
      entries: {
        firecrawl: {
          enabled: false,
          ...(apiKey
            ? {
                config: {
                  webSearch: {
                    apiKey,
                  },
                },
              }
            : {}),
        },
      },
    },
  };
}

function readFirecrawlPluginApiKey(config: OpenClawConfig): string | undefined {
  const pluginConfig = config.plugins?.entries?.firecrawl?.config as
    | {
        webSearch?: {
          apiKey?: string;
        };
      }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

async function runBlankPerplexityKeyEntry(
  apiKey: string,
  enabled?: boolean,
): Promise<OpenClawConfig> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({
    selectValue: "perplexity",
    textValue: "",
  });
  return setupSearch(cfg, runtime, prompter);
}

async function runQuickstartPerplexitySetup(
  apiKey: string,
  enabled?: boolean,
): Promise<{ result: OpenClawConfig; prompter: WizardPrompter }> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({ selectValue: "perplexity" });
  const result = await setupSearch(cfg, runtime, prompter, {
    quickstartDefaults: true,
  });
  return { result, prompter };
}

describe("setupSearch", () => {
  it("returns config unchanged when user skips", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result).toBe(cfg);
  });

  it("sets provider and key for perplexity", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "perplexity",
      textValue: "pplx-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("pplx-test-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.perplexity?.enabled).toBe(true);
  });

  it("sets provider and key for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "brave")).toBe("BSA-test-key");
    expect(result.plugins?.entries?.brave?.enabled).toBe(true);
  });

  it("sets provider and key for gemini", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "gemini",
      textValue: "AIza-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("gemini");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "google")).toBe("AIza-test");
    expect(result.plugins?.entries?.google?.enabled).toBe(true);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Gemini API key",
      }),
    );
  });

  it("sets provider and key for firecrawl and enables the plugin", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "firecrawl",
      textValue: "fc-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "firecrawl")).toBe("fc-test-key");
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
  });

  it("re-enables firecrawl and persists its plugin config when selected from disabled state", async () => {
    const cfg = createDisabledFirecrawlConfig();
    const { prompter } = createPrompter({
      selectValue: "firecrawl",
      textValue: "fc-disabled-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.firecrawl?.apiKey).toBeUndefined();
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(readFirecrawlPluginApiKey(result)).toBe("fc-disabled-key");
  });

  it("sets provider and key for grok", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "grok",
      textValue: "xai-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("grok");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.grok?.apiKey).toBe("xai-test");
  });

  it("sets provider and key for kimi", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "kimi",
      textValue: "sk-moonshot",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("kimi");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "moonshot")).toBe("sk-moonshot");
    expect(result.plugins?.entries?.moonshot?.enabled).toBe(true);
  });

  it("sets provider and key for tavily and enables the plugin", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "tavily",
      textValue: "tvly-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "tavily")).toBe("tvly-test-key");
    expect(result.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("shows missing-key note when no key is provided and no env var", async () => {
    const original = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter, notes } = createPrompter({
        selectValue: "brave",
        textValue: "",
      });
      const result = await setupSearch(cfg, runtime, prompter);
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
      const missingNote = notes.find((n) => n.message.includes("No Brave Search API key stored"));
      expect(missingNote).toBeDefined();
    } finally {
      if (original === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = original;
      }
    }
  });

  it("keeps existing key when user leaves input blank", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // pragma: allowlist secret
    );
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
  });

  it("advanced preserves enabled:false when keeping existing key", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // pragma: allowlist secret
      false,
    );
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
  });

  it("quickstart skips key prompt when config key exists", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // pragma: allowlist secret
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart preserves enabled:false when search was intentionally disabled", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // pragma: allowlist secret
      false,
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart skips key prompt when canonical plugin config key exists", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "tavily",
          },
        },
      },
      plugins: {
        entries: {
          tavily: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "tvly-existing-key",
              },
            },
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "tavily" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(pluginWebSearchApiKey(result, "tavily")).toBe("tvly-existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart falls through to key prompt when no key and no env var", async () => {
    const original = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "grok", textValue: "" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("grok");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = original;
      }
    }
  });

  it("uses provider-specific credential copy for kimi in onboarding", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "kimi",
      textValue: "",
    });
    await setupSearch(cfg, runtime, prompter);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Moonshot / Kimi API key",
      }),
    );
  });

  it("quickstart skips key prompt when env var is available", async () => {
    const orig = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "env-brave-key"; // pragma: allowlist secret
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "brave" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = orig;
      }
    }
  });

  it("quickstart detects an existing firecrawl key even when the plugin is disabled", async () => {
    const cfg = createDisabledFirecrawlConfig("fc-configured-key");
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(prompter.text).not.toHaveBeenCalled();
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.firecrawl?.apiKey).toBeUndefined();
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(readFirecrawlPluginApiKey(result)).toBe("fc-configured-key");
  });

  it("preserves disabled firecrawl plugin state and allowlist when web search stays disabled", async () => {
    const original = process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_KEY = "env-firecrawl-key"; // pragma: allowlist secret
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "firecrawl",
            enabled: false,
          },
        },
      },
      plugins: {
        allow: ["google"],
        entries: {
          firecrawl: {
            enabled: false,
          },
        },
      },
    };
    try {
      const { prompter } = createPrompter({ selectValue: "firecrawl" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).not.toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("firecrawl");
      expect(result.tools?.web?.search?.enabled).toBe(false);
      expect(result.plugins?.entries?.firecrawl?.enabled).toBe(false);
      expect(result.plugins?.allow).toEqual(["google"]);
    } finally {
      if (original === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = original;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for perplexity", async () => {
    const originalPerplexity = process.env.PERPLEXITY_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "perplexity" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // pragma: allowlist secret
      });
      expect(result.tools?.web?.search?.provider).toBe("perplexity");
      expect(pluginWebSearchApiKey(result, "perplexity")).toEqual({
        source: "env",
        provider: "default",
        id: "PERPLEXITY_API_KEY", // pragma: allowlist secret
      });
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (originalPerplexity === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = originalPerplexity;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  it("prefers detected OPENROUTER_API_KEY SecretRef for perplexity ref mode", async () => {
    const originalPerplexity = process.env.PERPLEXITY_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "perplexity" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // pragma: allowlist secret
      });
      expect(pluginWebSearchApiKey(result, "perplexity")).toEqual({
        source: "env",
        provider: "default",
        id: "OPENROUTER_API_KEY", // pragma: allowlist secret
      });
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (originalPerplexity === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = originalPerplexity;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "brave" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(pluginWebSearchApiKey(result, "brave")).toEqual({
      source: "env",
      provider: "default",
      id: "BRAVE_API_KEY",
    });
    expect(result.plugins?.entries?.brave?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores env-backed SecretRef when secretInputMode=ref for tavily", async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "tavily" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // pragma: allowlist secret
      });
      expect(result.tools?.web?.search?.provider).toBe("tavily");
      expect(pluginWebSearchApiKey(result, "tavily")).toEqual({
        source: "env",
        provider: "default",
        id: "TAVILY_API_KEY",
      });
      expect(result.plugins?.entries?.tavily?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = original;
      }
    }
  });

  it("stores plaintext key when secretInputMode is unset", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-plain",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(pluginWebSearchApiKey(result, "brave")).toBe("BSA-plain");
  });

  it("exports all 7 providers in SEARCH_PROVIDER_OPTIONS", () => {
    const values = SEARCH_PROVIDER_OPTIONS.map((e) => e.id);
    expect(SEARCH_PROVIDER_OPTIONS).toHaveLength(7);
    expect(values).toEqual([
      "brave",
      "gemini",
      "grok",
      "kimi",
      "perplexity",
      "firecrawl",
      "tavily",
    ]);
  });
});
