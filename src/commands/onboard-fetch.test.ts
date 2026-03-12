import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupFetch } from "./onboard-fetch.js";

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
  it("selects readability provider", async () => {
    const { prompter } = createPrompter({ selectValue: "readability" });
    const result = await setupFetch({}, prompter);
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
    const result = await setupFetch(config, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("firecrawl");
  });

  it("falls back to readability when firecrawl selected but not authenticated", async () => {
    const { prompter, notes } = createPrompter({ selectValue: "firecrawl" });
    const result = await setupFetch({}, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("readability");
    expect(notes.some((n) => n.message.includes("Firecrawl requires an API key"))).toBe(true);
  });

  it("prompts for scrapingbee API key and stores it", async () => {
    const { prompter } = createPrompter({
      selectValue: "scrapingbee",
      textValue: "sb-test-key-123",
    });
    const result = await setupFetch({}, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("scrapingbee");
    expect(result.tools?.web?.fetch?.scrapingbee?.apiKey).toBe("sb-test-key-123");
  });

  it("falls back to readability when scrapingbee key is empty", async () => {
    const { prompter, notes } = createPrompter({
      selectValue: "scrapingbee",
      textValue: "",
    });
    const result = await setupFetch({}, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("readability");
    expect(notes.some((n) => n.message.includes("No API key provided"))).toBe(true);
  });

  it("skips scrapingbee key prompt when env var is set", async () => {
    vi.stubEnv("SCRAPINGBEE_API_KEY", "sb-env-key");
    const { prompter } = createPrompter({ selectValue: "scrapingbee" });
    const result = await setupFetch({}, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("scrapingbee");
    // Should not have prompted for key
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
    const result = await setupFetch(config, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("scrapingbee");
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("returns config unchanged when user skips", async () => {
    const config: OpenClawConfig = { tools: { web: { fetch: { maxChars: 5000 } } } };
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    const result = await setupFetch(config, prompter);
    expect(result).toEqual(config);
  });

  it("quickstart shows picker and defaults to firecrawl when authenticated", async () => {
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
    const result = await setupFetch(config, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("firecrawl");
    expect(prompter.select).toHaveBeenCalled();
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { initialValue?: string }
      | undefined;
    expect(selectCall?.initialValue).toBe("firecrawl");
  });

  it("defaults to readability when not authenticated", async () => {
    const { prompter } = createPrompter({ selectValue: "readability" });
    const result = await setupFetch({}, prompter);
    expect(result.tools?.web?.fetch?.provider).toBe("readability");
    expect(prompter.select).toHaveBeenCalled();
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { initialValue?: string }
      | undefined;
    expect(selectCall?.initialValue).toBe("readability");
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
    await setupFetch(config, prompter);

    // Verify initialValue was the existing provider
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { initialValue?: string }
      | undefined;
    expect(selectCall?.initialValue).toBe("scrapingbee");
  });
});
