import { afterEach, describe, expect, test, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { __testing, createWebResearchTool } from "./web-research.js";

const { resolveResearchApiKey, resolveResearchEnabled } = __testing;

describe("web_research resolveResearchApiKey", () => {
  test("returns config key when set", () => {
    expect(resolveResearchApiKey({ apiKey: "ydc-config-key" })).toBe("ydc-config-key");
  });

  test("returns YDC_API_KEY from env", () => {
    withEnv({ YDC_API_KEY: "ydc-env-key" }, () => {
      expect(resolveResearchApiKey({})).toBe("ydc-env-key");
    });
  });

  test("returns undefined when no key is available", () => {
    withEnv({ YDC_API_KEY: "" }, () => {
      expect(resolveResearchApiKey({})).toBeUndefined();
    });
  });
});

describe("web_research resolveResearchEnabled", () => {
  test("returns true when explicitly enabled", () => {
    expect(resolveResearchEnabled({ research: { enabled: true } })).toBe(true);
  });

  test("returns false when explicitly disabled", () => {
    expect(resolveResearchEnabled({ research: { enabled: false } })).toBe(false);
  });

  test("returns true when apiKey is present", () => {
    expect(resolveResearchEnabled({ apiKey: "ydc-key" })).toBe(true);
  });

  test("returns false when no config and no apiKey", () => {
    expect(resolveResearchEnabled({})).toBe(false);
  });
});

describe("web_research tool creation", () => {
  test("returns null when no API key is configured", () => {
    withEnv({ YDC_API_KEY: "" }, () => {
      const tool = createWebResearchTool({ config: {} });
      expect(tool).toBeNull();
    });
  });

  test("returns null when explicitly disabled", () => {
    withEnv({ YDC_API_KEY: "ydc-key" }, () => {
      const tool = createWebResearchTool({
        config: { tools: { web: { research: { enabled: false } } } },
      });
      expect(tool).toBeNull();
    });
  });

  test("returns tool when API key is present", () => {
    withEnv({ YDC_API_KEY: "ydc-key" }, () => {
      const tool = createWebResearchTool({ config: {} });
      expect(tool).not.toBeNull();
      expect(tool?.name).toBe("web_research");
    });
  });
});

describe("web_research tool execution", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  test("returns missing key error when apiKey is absent at execute time", async () => {
    // Create tool with key present, then remove key before execution
    vi.stubEnv("YDC_API_KEY", "ydc-temp-key");
    const tool = createWebResearchTool({ config: {} });
    expect(tool).not.toBeNull();

    // The tool checks key at creation time for enabled/disabled,
    // but also at execute time. Since the key is baked in at creation,
    // the missing key path is only hit when tool was created without
    // the apiKey being resolved at creation. Let's test with config-based key.
    vi.stubEnv("YDC_API_KEY", "");
    const tool2 = createWebResearchTool({
      config: { tools: { web: { research: { enabled: true } } } },
    });
    expect(tool2).not.toBeNull();
    const result = await tool2?.execute?.("call-1", { input: "test query" });
    expect(result?.details).toMatchObject({ error: "missing_ydc_api_key" });
  });

  test("calls You.com Research API with correct params", async () => {
    vi.stubEnv("YDC_API_KEY", "ydc-test-key");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            output: {
              content: "Research result content",
              sources: [{ url: "https://example.com", title: "Example" }],
            },
          }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);

    const tool = createWebResearchTool({ config: {} });
    expect(tool).not.toBeNull();
    const result = await tool?.execute?.("call-1", {
      input: "What is quantum computing?",
      research_effort: "deep",
    });

    expect(mockFetch).toHaveBeenCalled();
    const requestInit = mockFetch.mock.calls[0]?.[1];
    const requestBody = JSON.parse(
      typeof requestInit?.body === "string" ? requestInit.body : "{}",
    ) as Record<string, unknown>;
    expect(requestBody.input).toBe("What is quantum computing?");
    expect(requestBody.research_effort).toBe("deep");

    const headers = requestInit?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("ydc-test-key");

    const details = result?.details as {
      content?: string;
      sources?: Array<{ url: string }>;
      effort?: string;
    };
    expect(details.content).toContain("Research result content");
    expect(details.sources).toHaveLength(1);
    expect(details.sources?.[0]?.url).toBe("https://example.com");
    // Title is wrapped with external content markers for prompt-injection safety
    expect(details.sources?.[0]?.title).toContain("Example");
    expect(details.effort).toBe("deep");
  });
});
