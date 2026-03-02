import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";
import { createPdfTool, resolvePdfModelConfigForTool } from "./pdf-tool.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: vi.fn(),
  };
});

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";
const OPENAI_PDF_MODEL = "openai/gpt-5-mini";
const FAKE_PDF_MEDIA = {
  kind: "document",
  buffer: Buffer.from("%PDF-1.4 fake"),
  contentType: "application/pdf",
  fileName: "doc.pdf",
} as const;

function resetAuthEnv() {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("MINIMAX_API_KEY", "");
  vi.stubEnv("ZAI_API_KEY", "");
  vi.stubEnv("Z_AI_API_KEY", "");
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
}

function withDefaultModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
  } as OpenClawConfig;
}

function withPdfModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { pdfModel: { primary } } },
  } as OpenClawConfig;
}

async function stubPdfToolInfra(
  agentDir: string,
  params?: {
  provider?: string;
  input?: string[];
  modelFound?: boolean;
  },
) {
  const webMedia = await import("../../web/media.js");
  const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA as never);

  const modelDiscovery = await import("../pi-model-discovery.js");
  vi.spyOn(modelDiscovery, "discoverAuthStorage").mockReturnValue({
    setRuntimeApiKey: vi.fn(),
  } as never);
  const find =
    params?.modelFound === false
      ? () => null
      : () =>
          ({
            provider: params?.provider ?? "anthropic",
            maxTokens: 8192,
            input: params?.input ?? ["text", "document"],
          }) as never;
  vi.spyOn(modelDiscovery, "discoverModels").mockReturnValue({ find } as never);

  const modelsConfig = await import("../models-config.js");
  vi.spyOn(modelsConfig, "ensureOpenClawModelsJson").mockResolvedValue({
    agentDir,
    wrote: false,
  });

  const modelAuth = await import("../model-auth.js");
  vi.spyOn(modelAuth, "getApiKeyForModel").mockResolvedValue({ apiKey: "test-key" } as never);
  vi.spyOn(modelAuth, "requireApiKey").mockReturnValue("test-key");

  return { loadSpy };
}

// ---------------------------------------------------------------------------
// parsePageRange tests
// ---------------------------------------------------------------------------

describe("parsePageRange", () => {
  it("parses a single page number", () => {
    expect(parsePageRange("3", 20)).toEqual([3]);
  });

  it("parses a page range", () => {
    expect(parsePageRange("1-5", 20)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses comma-separated pages and ranges", () => {
    expect(parsePageRange("1,3,5-7", 20)).toEqual([1, 3, 5, 6, 7]);
  });

  it("clamps to maxPages", () => {
    expect(parsePageRange("1-100", 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("deduplicates and sorts", () => {
    expect(parsePageRange("5,3,1,3,5", 20)).toEqual([1, 3, 5]);
  });

  it("throws on invalid page number", () => {
    expect(() => parsePageRange("abc", 20)).toThrow("Invalid page number");
  });

  it("throws on invalid range (start > end)", () => {
    expect(() => parsePageRange("5-3", 20)).toThrow("Invalid page range");
  });

  it("throws on zero page number", () => {
    expect(() => parsePageRange("0", 20)).toThrow("Invalid page number");
  });

  it("throws on negative page number", () => {
    expect(() => parsePageRange("-1", 20)).toThrow("Invalid page number");
  });

  it("handles empty parts gracefully", () => {
    expect(parsePageRange("1,,3", 20)).toEqual([1, 3]);
  });
});

// ---------------------------------------------------------------------------
// providerSupportsNativePdf tests
// ---------------------------------------------------------------------------

describe("providerSupportsNativePdf", () => {
  it("returns true for anthropic", () => {
    expect(providerSupportsNativePdf("anthropic")).toBe(true);
  });

  it("returns true for google", () => {
    expect(providerSupportsNativePdf("google")).toBe(true);
  });

  it("returns false for openai", () => {
    expect(providerSupportsNativePdf("openai")).toBe(false);
  });

  it("returns false for minimax", () => {
    expect(providerSupportsNativePdf("minimax")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(providerSupportsNativePdf("Anthropic")).toBe(true);
    expect(providerSupportsNativePdf("GOOGLE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PDF model config resolution
// ---------------------------------------------------------------------------

describe("resolvePdfModelConfigForTool", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    resetAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns null without any auth", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
      };
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toBeNull();
    });
  });

  it("prefers explicit pdfModel config", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            pdfModel: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      } as OpenClawConfig;
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "anthropic/claude-opus-4-6",
      });
    });
  });

  it("falls back to imageModel config when no pdfModel set", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            imageModel: { primary: "openai/gpt-5-mini" },
          },
        },
      };
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5-mini",
      });
    });
  });

  it("prefers anthropic when available for native PDF support", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      const cfg = withDefaultModel("openai/gpt-5.2");
      const config = resolvePdfModelConfigForTool({ cfg, agentDir });
      expect(config).not.toBeNull();
      // Should prefer anthropic for native PDF
      expect(config?.primary).toBe(ANTHROPIC_PDF_MODEL);
    });
  });

  it("uses anthropic primary when provider is anthropic", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      const config = resolvePdfModelConfigForTool({ cfg, agentDir });
      expect(config?.primary).toBe(ANTHROPIC_PDF_MODEL);
    });
  });
});

// ---------------------------------------------------------------------------
// createPdfTool
// ---------------------------------------------------------------------------

describe("createPdfTool", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    resetAuthEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns null without agentDir and no explicit config", () => {
    expect(createPdfTool()).toBeNull();
  });

  it("returns null without any auth configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
      };
      expect(createPdfTool({ config: cfg, agentDir })).toBeNull();
    });
  });

  it("throws when agentDir missing but explicit config present", () => {
    const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
    expect(() => createPdfTool({ config: cfg })).toThrow("requires agentDir");
  });

  it("creates tool when auth is available", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      expect(tool?.name).toBe("pdf");
      expect(tool?.label).toBe("PDF");
      expect(tool?.description).toContain("PDF documents");
    });
  });

  it("rejects when no pdf input provided", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      await expect(tool!.execute("t1", { prompt: "test" })).rejects.toThrow("pdf required");
    });
  });

  it("rejects too many PDFs", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      const manyPdfs = Array.from({ length: 15 }, (_, i) => `/tmp/doc${i}.pdf`);
      const result = await tool!.execute("t1", { prompt: "test", pdfs: manyPdfs });
      expect(result).toMatchObject({
        details: { error: "too_many_pdfs" },
      });
    });
  });

  it("rejects unsupported scheme references", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      const result = await tool!.execute("t1", {
        prompt: "test",
        pdf: "ftp://example.com/doc.pdf",
      });
      expect(result).toMatchObject({
        details: { error: "unsupported_pdf_reference" },
      });
    });
  });

  it("deduplicates pdf inputs before loading", async () => {
    await withTempAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, { modelFound: false });
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();

      await expect(
        tool!.execute("t1", {
          prompt: "test",
          pdf: "/tmp/nonexistent.pdf",
          pdfs: ["/tmp/nonexistent.pdf"],
        }),
      ).rejects.toThrow("Unknown model");

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("uses native PDF path without eager extraction", async () => {
    await withTempAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "anthropic", input: ["text", "document"] });

      const nativeProviders = await import("./pdf-native-providers.js");
      vi.spyOn(nativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");

      const extractModule = await import("../../media/pdf-extract.js");
      const extractSpy = vi.spyOn(extractModule, "extractPdfContent");

      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();

      const result = await tool!.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(extractSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        content: [{ type: "text", text: "native summary" }],
        details: { native: true, model: ANTHROPIC_PDF_MODEL },
      });
    });
  });

  it("rejects pages parameter for native PDF providers", async () => {
    await withTempAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "anthropic", input: ["text", "document"] });
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();

      await expect(
        tool!.execute("t1", {
          prompt: "summarize",
          pdf: "/tmp/doc.pdf",
          pages: "1-2",
        }),
      ).rejects.toThrow("pages is not supported with native PDF providers");
    });
  });

  it("uses extraction fallback for non-native models", async () => {
    await withTempAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "openai", input: ["text"] });

      const extractModule = await import("../../media/pdf-extract.js");
      const extractSpy = vi.spyOn(extractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });

      const piAi = await import("@mariozechner/pi-ai");
      vi.mocked(piAi.complete).mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      } as never);

      const cfg = withPdfModel(OPENAI_PDF_MODEL);

      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();

      const result = await tool!.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(extractSpy).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "fallback summary" }],
        details: { native: false, model: OPENAI_PDF_MODEL },
      });
    });
  });

  it("tool parameters have correct schema shape", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      const tool = createPdfTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      const schema = tool!.parameters;
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
      const props = schema.properties as Record<string, { type?: string }>;
      expect(props.prompt).toBeDefined();
      expect(props.pdf).toBeDefined();
      expect(props.pdfs).toBeDefined();
      expect(props.pages).toBeDefined();
      expect(props.model).toBeDefined();
      expect(props.maxBytesMb).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Native provider detection
// ---------------------------------------------------------------------------

describe("native PDF provider API calls", () => {
  const priorFetch = global.fetch;
  const mockFetchResponse = (response: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof global.fetch;
    return fetchMock;
  };

  afterEach(() => {
    global.fetch = priorFetch;
  });

  it("anthropicAnalyzePdf sends correct request shape", async () => {
    const { anthropicAnalyzePdf } = await import("./pdf-native-providers.js");
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Analysis of PDF" }],
      }),
    });

    const result = await anthropicAnalyzePdf({
      apiKey: "test-key",
      modelId: "claude-opus-4-6",
      prompt: "Summarize this document",
      pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      maxTokens: 4096,
    });

    expect(result).toBe("Analysis of PDF");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/messages");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[0].source.media_type).toBe("application/pdf");
    expect(body.messages[0].content[1].type).toBe("text");
  });

  it("anthropicAnalyzePdf throws on API error", async () => {
    const { anthropicAnalyzePdf } = await import("./pdf-native-providers.js");
    mockFetchResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid request",
    });

    await expect(
      anthropicAnalyzePdf({
        apiKey: "test-key",
        modelId: "claude-opus-4-6",
        prompt: "test",
        pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      }),
    ).rejects.toThrow("Anthropic PDF request failed");
  });

  it("anthropicAnalyzePdf throws when response has no text", async () => {
    const { anthropicAnalyzePdf } = await import("./pdf-native-providers.js");
    mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "   " }],
      }),
    });

    await expect(
      anthropicAnalyzePdf({
        apiKey: "test-key",
        modelId: "claude-opus-4-6",
        prompt: "test",
        pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      }),
    ).rejects.toThrow("Anthropic PDF returned no text");
  });

  it("geminiAnalyzePdf sends correct request shape", async () => {
    const { geminiAnalyzePdf } = await import("./pdf-native-providers.js");
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "Gemini PDF analysis" }] },
          },
        ],
      }),
    });

    const result = await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "gemini-2.5-pro",
      prompt: "Summarize this",
      pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
    });

    expect(result).toBe("Gemini PDF analysis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("generateContent");
    expect(url).toContain("gemini-2.5-pro");
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
    expect(body.contents[0].parts[1].text).toBe("Summarize this");
  });

  it("geminiAnalyzePdf throws on API error", async () => {
    const { geminiAnalyzePdf } = await import("./pdf-native-providers.js");
    mockFetchResponse({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "server error",
    });

    await expect(
      geminiAnalyzePdf({
        apiKey: "test-key",
        modelId: "gemini-2.5-pro",
        prompt: "test",
        pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      }),
    ).rejects.toThrow("Gemini PDF request failed");
  });

  it("geminiAnalyzePdf throws when no candidates returned", async () => {
    const { geminiAnalyzePdf } = await import("./pdf-native-providers.js");
    mockFetchResponse({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    await expect(
      geminiAnalyzePdf({
        apiKey: "test-key",
        modelId: "gemini-2.5-pro",
        prompt: "test",
        pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      }),
    ).rejects.toThrow("Gemini PDF returned no candidates");
  });

  it("anthropicAnalyzePdf supports multiple PDFs", async () => {
    const { anthropicAnalyzePdf } = await import("./pdf-native-providers.js");
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Multi-doc analysis" }],
      }),
    });

    await anthropicAnalyzePdf({
      apiKey: "test-key",
      modelId: "claude-opus-4-6",
      prompt: "Compare these documents",
      pdfs: [
        { base64: "cGRmMQ==", filename: "doc1.pdf" },
        { base64: "cGRmMg==", filename: "doc2.pdf" },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // 2 document blocks + 1 text block
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[1].type).toBe("document");
    expect(body.messages[0].content[2].type).toBe("text");
  });

  it("anthropicAnalyzePdf uses custom base URL", async () => {
    const { anthropicAnalyzePdf } = await import("./pdf-native-providers.js");
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await anthropicAnalyzePdf({
      apiKey: "test-key",
      modelId: "claude-opus-4-6",
      prompt: "test",
      pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      baseUrl: "https://custom.example.com",
    });

    expect(fetchMock.mock.calls[0][0]).toContain("https://custom.example.com/v1/messages");
  });

  it("anthropicAnalyzePdf requires apiKey", async () => {
    const { anthropicAnalyzePdf } = await import("./pdf-native-providers.js");
    await expect(
      anthropicAnalyzePdf({
        apiKey: "",
        modelId: "claude-opus-4-6",
        prompt: "test",
        pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      }),
    ).rejects.toThrow("apiKey required");
  });

  it("geminiAnalyzePdf requires apiKey", async () => {
    const { geminiAnalyzePdf } = await import("./pdf-native-providers.js");
    await expect(
      geminiAnalyzePdf({
        apiKey: "",
        modelId: "gemini-2.5-pro",
        prompt: "test",
        pdfs: [{ base64: "dGVzdA==", filename: "doc.pdf" }],
      }),
    ).rejects.toThrow("apiKey required");
  });
});

// ---------------------------------------------------------------------------
// PDF tool helpers
// ---------------------------------------------------------------------------

describe("pdf-tool.helpers", () => {
  it("resolvePdfToolMaxTokens respects model limit", () => {
    expect(resolvePdfToolMaxTokens(2048, 4096)).toBe(2048);
    expect(resolvePdfToolMaxTokens(8192, 4096)).toBe(4096);
    expect(resolvePdfToolMaxTokens(undefined, 4096)).toBe(4096);
  });

  it("coercePdfModelConfig reads primary and fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          pdfModel: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["google/gemini-2.5-pro"],
          },
        },
      },
    };
    expect(coercePdfModelConfig(cfg)).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["google/gemini-2.5-pro"],
    });
  });

  it("coercePdfAssistantText returns trimmed text", () => {
    const text = coercePdfAssistantText({
      provider: "anthropic",
      model: "claude-opus-4-6",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "  summary  " }],
      } as never,
    });
    expect(text).toBe("summary");
  });

  it("coercePdfAssistantText throws clear error for failed model output", () => {
    expect(() =>
      coercePdfAssistantText({
        provider: "google",
        model: "gemini-2.5-pro",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "bad request",
          content: [],
        } as never,
      }),
    ).toThrow("PDF model failed (google/gemini-2.5-pro): bad request");
  });
});

// ---------------------------------------------------------------------------
// Model catalog document support
// ---------------------------------------------------------------------------

describe("model catalog document support", () => {
  it("modelSupportsDocument returns true when input includes document", async () => {
    const { modelSupportsDocument } = await import("../model-catalog.js");
    expect(
      modelSupportsDocument({
        id: "test",
        name: "test",
        provider: "test",
        input: ["text", "document"],
      }),
    ).toBe(true);
  });

  it("modelSupportsDocument returns false when input lacks document", async () => {
    const { modelSupportsDocument } = await import("../model-catalog.js");
    expect(
      modelSupportsDocument({
        id: "test",
        name: "test",
        provider: "test",
        input: ["text", "image"],
      }),
    ).toBe(false);
  });

  it("modelSupportsDocument returns false for undefined entry", async () => {
    const { modelSupportsDocument } = await import("../model-catalog.js");
    expect(modelSupportsDocument(undefined)).toBe(false);
  });
});
