import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import { isRecord } from "../../utils.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);
const OPENAI_PDF_MODEL = "openai/gpt-5.4-mini";

function withPdfModel(primary: string): OpenClawConfig {
  return { agents: { defaults: { pdfModel: { primary } } } };
}

function expectDetails(value: unknown, expected: Record<string, unknown>): void {
  if (!isRecord(value)) {
    throw new Error("expected details object");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(value[key], key).toEqual(expectedValue);
  }
}

describe("createPdfTool OpenAI native routing", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses native input for the public OpenAI Responses endpoint", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      vi.spyOn(pdfNativeProviders, "openaiAnalyzePdf").mockResolvedValue("native OpenAI summary");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent");
      const { createPdfTool } = await import("./pdf-tool.js");
      const tool = createPdfTool({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir });
      if (!tool) {
        throw new Error("expected pdf tool");
      }

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(pdfNativeProviders.openaiAnalyzePdf).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: "gpt-5.4-mini",
          baseUrl: "https://api.openai.com/v1",
        }),
      );
      expect(extractSpy).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: "native OpenAI summary" }]);
      expectDetails(result.details, { native: true, model: OPENAI_PDF_MODEL });
    });
  });

  it.each([
    { pages: "1,3-4", expected: { pageNumbers: [1, 3, 4] } },
    { password: " fixture password ", expected: { password: " fixture password " } },
    { pages: "2", password: "fixture", expected: { pageNumbers: [2], password: "fixture" } },
  ])("preserves OpenAI extraction options: $expected", async ({ expected, ...options }) => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      const nativeSpy = vi.spyOn(pdfNativeProviders, "openaiAnalyzePdf");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Selected and decrypted content",
        images: [],
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      });
      const { createPdfTool } = await import("./pdf-tool.js");
      const tool = createPdfTool({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir });
      if (!tool) {
        throw new Error("expected pdf tool");
      }

      const result = await tool.execute("t1", { pdf: "/tmp/doc.pdf", ...options });

      expect(extractSpy).toHaveBeenCalledWith(expect.objectContaining(expected));
      expect(nativeSpy).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: "fallback summary" }]);
      expectDetails(result.details, { native: false, model: OPENAI_PDF_MODEL });
    });
  });

  it.each([
    { label: "combined limit", sizes: [25_000_000, 25_000_000], native: true },
    { label: "combined limit plus one byte", sizes: [25_000_000, 25_000_001], native: false },
    { label: "six individually valid PDFs", sizes: Array(6).fill(9_000_000), native: false },
    { label: "single file below limit", sizes: [49_999_999], native: true },
    { label: "single file at strict limit", sizes: [50_000_000], native: false },
  ])("routes original PDF sizes at $label", async ({ sizes, native }) => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        provider: "openai",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      for (const size of sizes) {
        loadSpy.mockResolvedValueOnce({ ...FAKE_PDF_MEDIA, buffer: Buffer.alloc(size) });
      }
      const nativeSpy = vi
        .spyOn(pdfNativeProviders, "openaiAnalyzePdf")
        .mockResolvedValue("native summary");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      });
      const { createPdfTool } = await import("./pdf-tool.js");
      const tool = createPdfTool({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir });
      if (!tool) {
        throw new Error("expected pdf tool");
      }

      const result = await tool.execute("t1", {
        pdfs: sizes.map((_, index) => `/tmp/doc-${index}.pdf`),
        maxBytesMb: 60,
      });

      expect(nativeSpy).toHaveBeenCalledTimes(native ? 1 : 0);
      expect(extractSpy).toHaveBeenCalledTimes(native ? 0 : sizes.length);
      expect(completeMock).toHaveBeenCalledTimes(native ? 0 : 1);
      expect(result.content).toEqual([
        { type: "text", text: native ? "native summary" : "fallback summary" },
      ]);
      expectDetails(result.details, { native, model: OPENAI_PDF_MODEL });
    });
  });

  it("uses extraction fallback for custom OpenAI Responses endpoints", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      });
      const nativeSpy = vi.spyOn(pdfNativeProviders, "openaiAnalyzePdf");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      } as never);
      const { createPdfTool } = await import("./pdf-tool.js");
      const tool = createPdfTool({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir });
      if (!tool) {
        throw new Error("expected pdf tool");
      }

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(nativeSpy).not.toHaveBeenCalled();
      expect(extractSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual([{ type: "text", text: "fallback summary" }]);
      expectDetails(result.details, { native: false, model: OPENAI_PDF_MODEL });
      expect(completeMock.mock.calls[0]?.[1].systemPrompt).toBeUndefined();
    });
  });

  it("uses extraction fallback for the ChatGPT/Codex transport", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        input: ["text", "image"],
        api: "openai-chatgpt-responses",
      });
      const nativeSpy = vi.spyOn(pdfNativeProviders, "openaiAnalyzePdf");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      } as never);
      const { createPdfTool } = await import("./pdf-tool.js");
      const tool = createPdfTool({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir });
      if (!tool) {
        throw new Error("expected pdf tool");
      }

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(nativeSpy).not.toHaveBeenCalled();
      expect(extractSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual([{ type: "text", text: "fallback summary" }]);
      expectDetails(result.details, { native: false, model: OPENAI_PDF_MODEL });
    });
  });
});
