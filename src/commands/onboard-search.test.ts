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
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("pplx-test-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
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
    expect(result.tools?.web?.search?.apiKey).toBe("BSA-test-key");
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
    expect(result.tools?.web?.search?.gemini?.apiKey).toBe("AIza-test");
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
    expect(result.tools?.web?.search?.kimi?.apiKey).toBe("sk-moonshot");
  });

  it("shows missing-key note when no key is provided and no env var", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter, notes } = createPrompter({
      selectValue: "brave",
      textValue: "",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.enabled).toBeUndefined();
    const missingNote = notes.find((n) => n.message.includes("No API key stored"));
    expect(missingNote).toBeDefined();
  });

  it("keeps existing key when user leaves input blank", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "perplexity",
            perplexity: { apiKey: "existing-key" }, // pragma: allowlist secret
          },
        },
      },
    };
    const { prompter } = createPrompter({
      selectValue: "perplexity",
      textValue: "",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
  });

  it("advanced preserves enabled:false when keeping existing key", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "perplexity",
            enabled: false,
            perplexity: { apiKey: "existing-key" }, // pragma: allowlist secret
          },
        },
      },
    };
    const { prompter } = createPrompter({
      selectValue: "perplexity",
      textValue: "",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
  });

  it("quickstart skips key prompt when config key exists", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "perplexity",
            perplexity: { apiKey: "stored-pplx-key" }, // pragma: allowlist secret
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "perplexity" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart preserves enabled:false when search was intentionally disabled", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "perplexity",
            enabled: false,
            perplexity: { apiKey: "stored-pplx-key" }, // pragma: allowlist secret
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "perplexity" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart falls through to key prompt when no key and no env var", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "grok", textValue: "" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(prompter.text).toHaveBeenCalled();
    expect(result.tools?.web?.search?.provider).toBe("grok");
    expect(result.tools?.web?.search?.enabled).toBeUndefined();
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

  it("stores env-backed SecretRef when secretInputMode=ref for perplexity", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "perplexity" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "PERPLEXITY_API_KEY", // pragma: allowlist secret
    });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores env-backed SecretRef when secretInputMode=ref for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "brave" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "BRAVE_API_KEY",
    });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores plaintext key when secretInputMode is unset", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-plain",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.apiKey).toBe("BSA-plain");
  });

  it("exports all 5 providers in SEARCH_PROVIDER_OPTIONS", () => {
    expect(SEARCH_PROVIDER_OPTIONS).toHaveLength(5);
    const values = SEARCH_PROVIDER_OPTIONS.map((e) => e.value);
    expect(values).toEqual(["perplexity", "brave", "gemini", "grok", "kimi"]);
  });
});
