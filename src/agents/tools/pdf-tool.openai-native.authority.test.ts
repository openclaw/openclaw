import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type {
  MediaUnderstandingProvider,
  PdfAnalysisRequest,
} from "../../media-understanding/types.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import { attachProviderAuthAuthority } from "../../plugins/provider-auth-authority.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as modelAuth from "../model-auth.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPdfTool } from "./pdf-tool.js";
import {
  createPdfToolInfraStub,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const complete = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
const { stubPdfToolInfra } = createPdfToolInfraStub(complete);
const model = "openai/gpt-4.1-mini";
let openaiMediaUnderstandingProvider: MediaUnderstandingProvider;

beforeAll(async () => {
  ({ openaiMediaUnderstandingProvider } = await loadBundledPluginFacade<{
    openaiMediaUnderstandingProvider: MediaUnderstandingProvider;
  }>({ pluginId: "openai", artifactBasename: "api.js" }));
});

beforeEach(() => {
  resetPdfToolAuthEnv();
  complete.mockReset();
  fetchMock.mockReset().mockResolvedValue(
    Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "native fixture" }] }],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function runCase(
  owner: "operator" | "credential",
  stage: "allowed" | "denied" | "provider" | "dns",
) {
  return withTempPdfAgentDir(async (agentDir) => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error(`${owner} fixture retired`);
      }
    };
    const analyze = vi.fn(async (req: PdfAnalysisRequest) => {
      // The real bundled callback also awaits its module before transport preparation.
      await Promise.resolve();
      if (stage === "provider") {
        current = false;
      }
      if (stage === "dns") {
        // Explicit lookup exercises the real final-dispatch guard; fetch mocks
        // otherwise intentionally bypass DNS to keep bundled provider tests hermetic.
        const { response, release } = await fetchWithSsrFGuard({
          url: "https://api.openai.com/v1/responses",
          init: { method: "POST", body: "synthetic PDF transport fixture" },
          signal: req.signal,
          lookupFn: async () => {
            await Promise.resolve();
            current = false;
            return [{ address: "93.184.216.34", family: 4 }];
          },
          fetchImpl: fetchMock,
        });
        try {
          await response.json();
          return { text: "native fixture" };
        } finally {
          await release();
        }
      }
      return openaiMediaUnderstandingProvider.analyzePdf!(req);
    });
    await stubPdfToolInfra(agentDir, {
      provider: "openai",
      input: ["text", "image"],
      baseUrl: "https://api.openai.com/v1",
      mediaUnderstandingProviders: [{ id: "openai", analyzePdf: analyze }],
    });
    if (owner === "credential") {
      vi.spyOn(modelAuth, "getApiKeyForModelCore").mockResolvedValue(
        attachProviderAuthAuthority(
          { apiKey: "synthetic-pdf-key", mode: "api-key", source: "fixture" },
          assertCurrent,
        ),
      );
    }
    vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({
      text: "bounded fixture",
      images: [],
      metadata: {
        pages: { total: 1, processed: [1], selection: "automatic", truncated: false },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
    const config: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model, pdfModel: { primary: model }, pdfNativeOpenai: true },
      },
    };
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "pdf-authority-fixture",
      scopes: ["operator.write"],
      // Deliberately assert-only: a signal is optional in the native source contract.
      assertCurrent: owner === "operator" ? assertCurrent : () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg: config,
        policy: { sourceAgent: "main", ...(stage === "denied" ? { deny: [model] } : {}) },
        manifestPlugins: [],
      }),
    });
    const tool = createPdfTool({ config, agentDir });
    if (!tool) {
      throw new Error("missing PDF fixture tool");
    }
    const outcome = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:pdf-fixture", operatorAuthority: authority },
      () => tool.execute("pdf-authority", { pdf: "/tmp/synthetic.pdf" }),
    ).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { outcome, analyze, retirementReached: !current };
  });
}

describe("native PDF final-effect authority", () => {
  it("allows the original live operator and credential owner", async () => {
    const { outcome } = await runCase("operator", "allowed");
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.details).toMatchObject({ native: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not invoke the native provider for the nearest forbidden operator", async () => {
    const { outcome, analyze } = await runCase("operator", "denied");
    expect(outcome.error).toBeDefined();
    expect(analyze).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["operator", "provider"],
    ["credential", "provider"],
    ["operator", "dns"],
    ["credential", "dns"],
  ] as const)("refuses %s retirement during %s preparation before HTTP", async (owner, stage) => {
    const { outcome, retirementReached } = await runCase(owner, stage);
    expect(retirementReached).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(outcome.error)).toContain(`${owner} fixture retired`);
    expect(complete).not.toHaveBeenCalled();
  });
});
