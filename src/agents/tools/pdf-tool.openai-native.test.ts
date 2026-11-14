import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import { sealSecretSentinel } from "../../secrets/sentinel.js";
import * as modelAuth from "../model-auth.js";
import { createPdfTool } from "./pdf-tool.js";
import {
  createPdfToolInfraStub,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const complete = vi.fn();
const { stubPdfToolInfra } = createPdfToolInfraStub(complete);
const completePages = {
  pages: { processed: [1, 2], total: 2, selection: "automatic" as const, truncated: false },
  textTruncated: false,
  imagesTruncated: false,
};

beforeEach(() => {
  resetPdfToolAuthEnv();
  complete.mockReset().mockResolvedValue({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "bounded extraction" }],
  });
});
afterEach(() => vi.restoreAllMocks());

async function runCase(params: {
  enabled?: boolean;
  input?: string[];
  args?: Record<string, unknown>;
  metadata?: typeof completePages;
  unsupported?: boolean;
  authValue?: string;
  headers?: Record<string, string | null>;
}) {
  return withTempPdfAgentDir(async (agentDir) => {
    const native = vi.fn(async () =>
      params.unsupported ? undefined : { text: "native document" },
    );
    await stubPdfToolInfra(agentDir, {
      provider: "openai",
      input: params.input ?? ["text", "image"],
      baseUrl: "https://api.openai.com/v1",
      headers: params.headers,
      mediaUnderstandingProviders: [{ id: "openai", analyzePdf: native }],
    });
    if (params.authValue) {
      vi.spyOn(modelAuth, "requireApiKey").mockReturnValue(params.authValue);
    }
    const extract = vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({
      text: "bounded document",
      images: [],
      ...(params.metadata ? { metadata: params.metadata } : {}),
    });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          pdfModel: { primary: "openai/gpt-4.1-mini" },
          pdfMaxPages: 20,
          ...(params.enabled === undefined ? {} : { pdfNativeOpenai: params.enabled }),
        },
      },
    };
    const tool = createPdfTool({ config, agentDir });
    if (!tool) {
      throw new Error("expected PDF tool");
    }
    const result = await tool.execute("pdf-opt-in", { pdf: "/tmp/synthetic.pdf", ...params.args });
    return { result, native, extract };
  });
}

describe("OpenAI native PDF opt-in", () => {
  it.each([undefined, false, true])(
    "preserves extraction unless explicitly enabled (%s)",
    async (enabled) => {
      const { result, native } = await runCase({ enabled, metadata: completePages });
      expect(result.details).toMatchObject({
        native: enabled === true,
        model: "openai/gpt-4.1-mini",
      });
      expect(native).toHaveBeenCalledTimes(enabled === true ? 1 : 0);
      expect(complete).toHaveBeenCalledTimes(enabled === true ? 0 : 1);
    },
  );

  it.each([
    { name: "page selection", args: { pages: "2" }, metadata: completePages },
    { name: "password", args: { password: "synthetic-password" }, metadata: completePages },
    { name: "unknown completeness", metadata: undefined },
    {
      name: "page limit",
      metadata: {
        ...completePages,
        pages: {
          ...completePages.pages,
          processed: Array.from({ length: 20 }, (_, i) => i + 1),
          total: 30,
          truncated: true,
        },
      },
    },
    { name: "truncated extracted text", metadata: { ...completePages, textTruncated: true } },
    { name: "truncated page images", metadata: { ...completePages, imagesTruncated: true } },
    { name: "text-only model", input: ["text"], metadata: completePages },
  ])("keeps bounded extraction for $name", async (params) => {
    const { result, native, extract } = await runCase({ enabled: true, ...params });
    expect(result.details).toMatchObject({ native: false });
    expect(native).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    if (params.args?.pages) {
      expect(extract).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: [2] }));
    }
    if (params.args?.password) {
      expect(extract).toHaveBeenCalledWith(
        expect.objectContaining({ password: "synthetic-password" }),
      );
    }
  });

  it("uses its existing extraction when the provider rejects native eligibility before upload", async () => {
    const { result, native, extract } = await runCase({
      enabled: true,
      metadata: completePages,
      unsupported: true,
    });
    expect(native).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ native: false });
    expect(extract).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("materializes nullable model headers before the native provider handoff", async () => {
    const { native } = await runCase({
      enabled: true,
      metadata: completePages,
      headers: { "X-Pdf-Fixture": "kept", "X-Pdf-Removed": null },
    });
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { "X-Pdf-Fixture": "kept" } }),
    );
  });

  it("opens prepared credential sentinels only at the admitted provider handoff", async () => {
    const credential = "synthetic-provider-key";
    const { native } = await runCase({
      enabled: true,
      metadata: completePages,
      authValue: sealSecretSentinel(credential, { label: "pdf-auth-regression" }),
    });
    expect(native).toHaveBeenCalledWith(expect.objectContaining({ apiKey: credential }));
  });

  it("refuses an unknown credential sentinel before the provider handoff", async () => {
    await expect(
      runCase({
        enabled: true,
        metadata: completePages,
        authValue: "oc-sent-v2.unknown.end",
      }),
    ).rejects.toThrow(/not registered/);
  });
});
