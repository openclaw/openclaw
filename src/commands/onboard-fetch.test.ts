import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupFetch } from "./onboard-fetch.js";

vi.mock("./onboard-search.js", async (importOriginal) => {
  const actual: object = await importOriginal();
  return {
    ...actual,
    runFirecrawlOAuth: vi.fn(async (config: OpenClawConfig) => ({
      ...config,
      tools: {
        ...config.tools,
        web: {
          ...config.tools?.web,
          search: {
            ...config.tools?.web?.search,
            provider: "firecrawl",
            firecrawl: { apiKey: "fc-oauth-key" },
          },
          fetch: {
            ...config.tools?.web?.fetch,
            provider: "firecrawl",
            firecrawl: { enabled: true, apiKey: "fc-oauth-key" },
          },
        },
      },
    })),
  };
});

function createRuntime(): RuntimeEnv {
  return { log: vi.fn() } as unknown as RuntimeEnv;
}

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
      async () => params.selectValue ?? "readability",
    ) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => params.textValue ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
  return { prompter, notes };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("setupFetch", () => {
  const runtime = createRuntime();

  it("selects readability provider", async () => {
    const { prompter } = createPrompter({ selectValue: "readability" });
    const result = await setupFetch({}, runtime, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("readability");
  });

  it("selects firecrawl when already authenticated", async () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            firecrawl: { apiKey: "fc-existing" },
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    const result = await setupFetch(config, runtime, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("firecrawl");
  });

  it("runs OAuth when firecrawl selected but not authenticated", async () => {
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    const result = await setupFetch({}, runtime, prompter);
    // runFirecrawlOAuth mock sets both search and fetch providers
    expect(result.tools?.web?.fetch?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-oauth-key");
  });

  it("prompts for scrapingbee API key and stores it", async () => {
    const { prompter } = createPrompter({
      selectValue: "scrapingbee",
      textValue: "sb-test-key-123",
    });
    const result = await setupFetch({}, runtime, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("scrapingbee");
    expect(result.tools?.web?.fetch?.scrapingbee?.apiKey).toBe("sb-test-key-123");
  });

  it("falls back to readability when scrapingbee key is empty", async () => {
    const { prompter, notes } = createPrompter({
      selectValue: "scrapingbee",
      textValue: "",
    });
    const result = await setupFetch({}, runtime, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("readability");
    expect(notes.some((n) => n.message.includes("No API key provided"))).toBe(true);
  });

  it("skips scrapingbee key prompt when env var is set", async () => {
    vi.stubEnv("SCRAPINGBEE_API_KEY", "sb-env-key");
    const { prompter } = createPrompter({ selectValue: "scrapingbee" });
    const result = await setupFetch({}, runtime, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("scrapingbee");
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("skips scrapingbee key prompt when config key exists", async () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          fetch: {
            scrapingbee: { apiKey: "sb-config-key" },
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "scrapingbee" });
    const result = await setupFetch(config, runtime, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("scrapingbee");
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("returns config unchanged when user skips", async () => {
    const config: OpenClawConfig = { tools: { web: { fetch: { maxChars: 5000 } } } };
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    const result = await setupFetch(config, runtime, prompter);
    expect(result).toEqual(config);
  });

  it("defaults to firecrawl when authenticated", async () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            firecrawl: { apiKey: "fc-key" },
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    await setupFetch(config, runtime, prompter);
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { initialValue?: string }
      | undefined;
    expect(selectCall?.initialValue).toBe("firecrawl");
  });

  it("defaults to firecrawl even when not authenticated", async () => {
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    await setupFetch({}, runtime, prompter);
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { initialValue?: string }
      | undefined;
    expect(selectCall?.initialValue).toBe("firecrawl");
  });

  it("defaults to existing provider in picker", async () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          fetch: { provider: "scrapingbee", scrapingbee: { apiKey: "sb-key" } },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "scrapingbee" });
    await setupFetch(config, runtime, prompter);
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { initialValue?: string }
      | undefined;
    expect(selectCall?.initialValue).toBe("scrapingbee");
  });
});
