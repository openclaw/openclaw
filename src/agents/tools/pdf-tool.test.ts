import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as operatorInvocation from "../../gateway/operator-invocation-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as modelResolution from "../embedded-agent-runner/model.js";
import * as modelAuth from "../model-auth.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import * as preparedRuntime from "../prepared-model-runtime.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createContainerWorkspaceSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as pdfNative from "./pdf-native-providers.js";
import { createPdfTool } from "./pdf-tool.js";
import * as pdfModelConfig from "./pdf-tool.model-config.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withPreparedRuntimeFacts,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, completeSimple: completeMock };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { stubPdfToolInfra, createPdfModelRegistry } = createPdfToolInfraStub(completeMock);
const ANTHROPIC = "anthropic/claude-opus-4-6";
const OPENAI = "openai/gpt-5.4-mini";
const FALLBACK = "openai/gpt-5.4";
const pdfConfig = (primary: string): OpenClawConfig => ({
  agents: { defaults: { pdfModel: { primary } } },
});
type Options = Omit<NonNullable<Parameters<typeof createPdfTool>[0]>, "agentDir">;
let agentDir: string;

beforeEach(() => {
  agentDir = tempDirs.make("openclaw-pdf-");
  resetPdfToolAuthEnv();
  completeMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function tool(options: Options = {}) {
  const pdf = createPdfTool({ agentDir, config: pdfConfig(ANTHROPIC), ...options });
  if (!pdf) {
    throw new Error("expected PDF tool");
  }
  return pdf;
}
const summary = (text = "fallback summary") =>
  makeAssistantMessageFixture({
    stopReason: "stop",
    errorMessage: undefined,
    content: [{ type: "text", text }],
  });
async function native(options: Options = {}, mockLoad = true) {
  const infra = await stubPdfToolInfra(agentDir, {
    provider: "anthropic",
    input: ["text", "document"],
    mockLoad,
  });
  const analyze = vi.spyOn(pdfNative, "anthropicAnalyzePdf").mockResolvedValue("native summary");
  return { ...infra, analyze, pdf: tool(options) };
}
async function extraction(api = "openai-responses", config = pdfConfig(OPENAI)) {
  const infra = await stubPdfToolInfra(agentDir, { provider: "openai", api, input: ["text"] });
  const extract = vi
    .spyOn(pdfExtract, "extractPdfContent")
    .mockResolvedValue({ text: "Extracted content", images: [] });
  completeMock.mockResolvedValue(summary());
  return { ...infra, extract, pdf: tool({ config }) };
}
function context():
  | {
      systemPrompt?: string;
      messages?: Array<{ content?: Array<{ type: string; text?: string }> }>;
    }
  | undefined {
  return completeMock.mock.calls[0]?.[1];
}
const contextText = () =>
  context()
    ?.messages?.[0]?.content?.map((item) => item.text ?? "")
    .join("\n");

it("resolves deferred model config before loading PDFs", async () => {
  const resolve = vi.spyOn(pdfModelConfig, "resolvePdfModelConfigForTool").mockReturnValue(null);
  const load = vi.spyOn(webMedia, "loadWebMediaRaw");
  const pdf = tool({
    config: { agents: { defaults: { model: { primary: FALLBACK } } } },
    deferAutoModelResolution: true,
  });
  expect(resolve).not.toHaveBeenCalled();
  await expect(pdf.execute("pdf", { pdf: "/tmp/doc.pdf" })).rejects.toThrow(
    "No PDF model configured.",
  );
  expect(resolve).toHaveBeenCalledOnce();
  expect(load).not.toHaveBeenCalled();
});

it("sends workspace-relative PDF bytes directly to a native provider", async () => {
  const workspaceDir = path.join(agentDir, "workspace");
  await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
  const bytes = Buffer.from("%PDF-1.4 workspace payload");
  await fs.writeFile(path.join(workspaceDir, "docs/guide.pdf"), bytes);
  const { pdf, analyze } = await native({ workspaceDir, fsPolicy: { workspaceOnly: true } }, false);
  const extract = vi.spyOn(pdfExtract, "extractPdfContent");
  const result = await pdf.execute("pdf", { pdf: "docs/guide.pdf", prompt: "summarize" });
  expect(analyze.mock.calls[0]?.[0].pdfs[0]?.base64).toBe(bytes.toString("base64"));
  expect(extract).not.toHaveBeenCalled();
  expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
});

it("rejects paths outside the workspace", async () => {
  const workspaceDir = tempDirs.make("openclaw-pdf-ws-");
  const outside = path.join(tempDirs.make("openclaw-pdf-out-"), "secret.pdf");
  await fs.writeFile(outside, "%PDF-1.4 fake");
  await expect(
    tool({ workspaceDir, fsPolicy: { workspaceOnly: true } }).execute("pdf", { pdf: outside }),
  ).rejects.toThrow(/not under an allowed directory/i);
});

it("rejects data URLs", async () => {
  const result = await tool().execute("pdf", { pdf: "data:application/pdf;base64,JVBERi0xLjQ=" });
  expect(result.details).toMatchObject({ error: "unsupported_pdf_reference" });
});

it("admits managed inbound refs under workspace-only policy", async () => {
  const stateDir = tempDirs.make("openclaw-pdf-inbound-");
  const inboundDir = path.join(stateDir, "media/inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  await fs.writeFile(path.join(inboundDir, "claim.pdf"), FAKE_PDF_MEDIA.buffer);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const { pdf, loadSpy } = await native({ fsPolicy: { workspaceOnly: true } }, false);
    const result = await pdf.execute("pdf", { pdf: "media://inbound/claim.pdf" });
    expect(loadSpy).toHaveBeenCalledWith(
      "media://inbound/claim.pdf",
      expect.objectContaining({ localRoots: [path.join(stateDir, "media")] }),
    );
    expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
  });
});

it("resolves a producer-staged bare PDF handle", async () => {
  const workspaceDir = tempDirs.make("openclaw-pdf-sandbox-");
  const stagedPath = "media/inbound/openclaw-staged-proof/input-file_upload.pdf";
  await fs.mkdir(path.dirname(path.join(workspaceDir, stagedPath)), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, stagedPath), FAKE_PDF_MEDIA.buffer);
  const { pdf } = await native(
    {
      workspaceDir,
      fsPolicy: { workspaceOnly: true },
      sandbox: {
        root: workspaceDir,
        bridge: createContainerWorkspaceSandboxFsBridge(workspaceDir),
        stagedMediaPaths: new Map([["file_upload", stagedPath]]),
      },
    },
    false,
  );
  const result = await pdf.execute("pdf", { pdf: "file_upload" });
  expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
  expect(result.details).toMatchObject({ rewrittenFrom: "file_upload" });
});

it("passes web_fetch SSRF policy to remote PDF loading", async () => {
  const { pdf, loadSpy } = await native({
    config: {
      ...pdfConfig(ANTHROPIC),
      tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
    },
  });
  await pdf.execute("pdf", { pdf: "http://198.18.0.153/doc.pdf", maxBytesMb: "0.5" });
  expect(loadSpy).toHaveBeenCalledWith(
    "http://198.18.0.153/doc.pdf",
    expect.objectContaining({
      maxBytes: 524_288,
      readIdleTimeoutMs: 120_000,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    }),
  );
  expect(modelAuth.getApiKeyForModelCore).toHaveBeenCalledWith(
    expect.objectContaining({ secretSentinels: true }),
  );
});

it.each([
  ["1-100,2.5", "2.5"],
  ["1,9007199254740992", "9007199254740992"],
])("rejects invalid page selection %s before media or provider work", async (pages, invalid) => {
  const { pdf, loadSpy, extract } = await extraction();
  await expect(pdf.execute("pdf", { pdf: "/tmp/doc.pdf", pages })).rejects.toThrow(
    `Invalid page number: "${invalid}"`,
  );
  expect(loadSpy).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
  expect(completeMock).not.toHaveBeenCalled();
});

it.each([
  ["pages", "999"],
  ["password", "test-password"],
])("rejects %s for native providers", async (field, value) => {
  const { pdf, analyze } = await native();
  await expect(pdf.execute("pdf", { pdf: "/tmp/doc.pdf", [field]: value })).rejects.toThrow(
    `${field} is not supported with native PDF providers`,
  );
  expect(analyze).not.toHaveBeenCalled();
});

it("selects later pages and reports partial extraction to both models", async () => {
  const { pdf, extract } = await extraction("openai-responses", {
    agents: { defaults: { pdfModel: { primary: OPENAI }, pdfMaxPages: 2 } },
  });
  const result = await pdf.execute("pdf", {
    pdf: "/tmp/doc.pdf",
    pages: "21-23",
    password: " secret ",
    prompt: "summarize",
  });
  expect(extract).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ pageNumbers: [21, 22], maxPages: 2, password: " secret " }),
  );
  const notice = "[Partial document: requested page selection limited to 2 pages.]";
  expect(contextText()).toContain(notice);
  expect(contextText()).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
  expect(result.content).toEqual([{ type: "text", text: `${notice}\nfallback summary` }]);
  expect(result.details).toMatchObject({ native: false, model: OPENAI });
});

it.each([true, false])(
  "reuses only successful extraction across fallbacks (overloaded=%s)",
  async (overloaded) => {
    const { pdf, extract } = await extraction("openai-responses", {
      agents: { defaults: { pdfModel: { primary: OPENAI, fallbacks: [FALLBACK] } } },
    });
    extract.mockResolvedValue({ text: "Recovered document content", images: [] });
    if (overloaded) {
      extract.mockRejectedValueOnce(
        new WorkerTaskError("worker task capacity reached", "overloaded"),
      );
    } else {
      completeMock.mockRejectedValueOnce(new Error("temporary provider failure"));
    }
    completeMock.mockResolvedValue(summary("Recovered PDF summary"));
    const result = await pdf.execute("pdf", { pdf: "/tmp/doc.pdf", prompt: "summarize" });
    expect(result.content).toEqual([{ type: "text", text: "Recovered PDF summary" }]);
    expect(result.details).toMatchObject({ model: FALLBACK, native: false });
    expect(contextText()).toContain("Recovered document content");
    expect(extract).toHaveBeenCalledTimes(overloaded ? 2 : 1);
    expect(completeMock).toHaveBeenCalledTimes(overloaded ? 1 : 2);
  },
);

it.each(["bedrock-converse-stream", "openai-completions"])(
  "allows keyless AWS SDK auth only for the Bedrock transport (%s)",
  async (api) => {
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const { setRuntimeApiKey } = await stubPdfToolInfra(agentDir, {
      provider: "amazon-bedrock",
      api,
      input: ["text", "image"],
    });
    vi.mocked(modelAuth.getApiKeyForModelCore).mockResolvedValue({
      apiKey: "",
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });
    vi.mocked(modelAuth.requireApiKey).mockImplementation(() => {
      throw new Error("must not require a literal API key");
    });
    vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({
      text: "Extracted content",
      images: [],
    });
    completeMock.mockResolvedValue(summary("Bedrock summary"));
    const config: OpenClawConfig =
      api === "bedrock-converse-stream"
        ? {
            agents: { defaults: { model: "amazon-bedrock/text-1" } },
            models: {
              providers: {
                "amazon-bedrock": {
                  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                  auth: "aws-sdk",
                  api: "bedrock-converse-stream",
                  models: [
                    {
                      id: "vision-1",
                      name: "Bedrock Vision",
                      input: ["text", "image"],
                      reasoning: false,
                      contextWindow: 16_000,
                      maxTokens: 4_096,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
          }
        : pdfConfig("amazon-bedrock/us.anthropic.claude-sonnet-4-6");
    const pdf = tool({ config });
    if (api !== "bedrock-converse-stream") {
      vi.mocked(modelAuth.requireApiKey).mockRestore();
      await expect(pdf.execute("pdf", { pdf: "/tmp/doc.pdf" })).rejects.toThrow("No API key");
      expect(completeMock).not.toHaveBeenCalled();
      return;
    }
    expect((await pdf.execute("pdf", { pdf: "/tmp/doc.pdf" })).content).toEqual([
      { type: "text", text: "Bedrock summary" },
    ]);
    expect(modelAuth.requireApiKey).not.toHaveBeenCalled();
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "amazon-bedrock", id: "vision-1", api }),
      expect.anything(),
      expect.objectContaining({ apiKey: "" }),
      expect.any(Function),
    );
  },
);

it("reports omitted images for a text-only model and supplies Codex instructions", async () => {
  const { pdf, extract } = await extraction("openai-chatgpt-responses", pdfConfig(FALLBACK));
  extract.mockResolvedValue({
    text: "Extracted content",
    images: [{ type: "image", data: "base64img", mimeType: "image/png" }],
    metadata: { textTruncated: false, imagesTruncated: false },
  });
  completeMock.mockResolvedValue(summary("codex summary"));
  const result = await pdf.execute("pdf", { pdf: "/tmp/doc.pdf", prompt: "summarize" });
  const notice = "[Partial document: image rendering truncated.]";
  expect(result.content).toEqual([{ type: "text", text: `${notice}\ncodex summary` }]);
  expect(context()?.messages?.[0]?.content?.some((item) => item.type === "image")).toBe(false);
  expect(contextText()).toContain(notice);
  expect(result.details).toMatchObject({ native: false, model: FALLBACK });
  expect(completeMock).toHaveBeenCalledOnce();
  expect(context()?.systemPrompt).toContain("Analyze the provided PDF content");
});

it("aborts before downloads or paid model calls", async () => {
  const { pdf, analyze, loadSpy } = await native();
  const controller = new AbortController();
  controller.abort();
  await expect(
    pdf.execute("pdf", { pdfs: ["/tmp/a.pdf", "/tmp/b.pdf"] }, controller.signal),
  ).rejects.toThrow();
  expect(loadSpy).not.toHaveBeenCalled();
  expect(analyze).not.toHaveBeenCalled();
  expect(completeMock).not.toHaveBeenCalled();
});

it("cancels the active download without starting remaining downloads", async () => {
  const { pdf, analyze, loadSpy } = await native();
  const controller = new AbortController();
  const started = createDeferredCore();
  loadSpy.mockImplementation(async (_url, options) => {
    const signal = typeof options === "object" ? options.requestInit?.signal : undefined;
    expect(signal).toBe(controller.signal);
    started.resolve();
    return await new Promise<never>((_, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted", { cause: signal.reason })),
        { once: true },
      );
    });
  });
  const execution = pdf.execute(
    "pdf",
    { pdfs: ["/tmp/a.pdf", "/tmp/b.pdf", "/tmp/c.pdf"] },
    controller.signal,
  );
  await started.promise;
  controller.abort();
  await expect(execution).rejects.toThrow();
  expect(loadSpy).toHaveBeenCalledOnce();
  expect(analyze).not.toHaveBeenCalled();
  expect(completeMock).not.toHaveBeenCalled();
});

it("uses the committed runtime generation for native PDF model selection", async () => {
  await stubPdfToolInfra(agentDir, {
    provider: "google",
    api: "google-generative-ai",
    input: ["text", "document"],
  });
  const modelRegistry = createPdfModelRegistry(() => ({
    provider: "google",
    api: "google-generative-ai",
    maxTokens: 8192,
    input: ["text", "document"],
  }));
  const release = vi.fn(async () => {});
  vi.mocked(preparedRuntime.acquireAgentRunPreparedModelRuntime).mockResolvedValueOnce({
    snapshot: withPreparedRuntimeFacts({
      agentDir: "/tmp/committed-pdf-agent",
      workspaceDir: path.join(agentDir, "committed-workspace"),
      config: pdfConfig("google/gemini-2.5-pro"),
      createStores: () => ({ authStorage: { setRuntimeApiKey: vi.fn() }, modelRegistry }),
    }),
    [Symbol.asyncDispose]: release,
  } as never);
  const analyze = vi
    .spyOn(pdfNative, "geminiAnalyzePdf")
    .mockResolvedValue("committed native summary");
  const pdf = tool({ workspaceDir: path.join(agentDir, "requested-workspace") });
  const work = new AsyncWorkScope();
  try {
    const result = await work.track(() =>
      pdf.execute("pdf", { pdf: "/tmp/doc.pdf", prompt: "summarize" }),
    );
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gemini-2.5-pro" }));
    expect(result.details).toMatchObject({ model: "google/gemini-2.5-pro", native: true });
  } finally {
    await work.drain();
  }
  expect(release).toHaveBeenCalledOnce();
});

describe("PDF tool prepared-runtime cancellation", () => {
  afterEach(() => {
    completeMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    { source: "admitted", scenario: "denied override" },
    { source: "direct", scenario: "permitted fallback" },
    { source: "admitted", scenario: "retired after extraction" },
    { source: "admitted", scenario: "mutated override" },
    { source: "admitted", scenario: "mutated path" },
  ] as const)(
    "preserves $source requester model policy for $scenario",
    async ({ source, scenario }) => {
      await withTempPdfAgentDir(async (runtimeAgentDir) => {
        const { loadSpy } = await stubPdfToolInfra(runtimeAgentDir, {
          provider: "test-provider",
          api: "openai-completions",
          input: ["text"],
        });
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: {
            entries: { main: {} },
            defaults: {
              model: "test-provider/allowed",
              models: { "test-provider/blocked": { alias: "blocked-alias" } },
              pdfModel: { primary: "test-provider/blocked", fallbacks: ["test-provider/allowed"] },
            },
          },
        };
        let active = true;
        let sourceHolds = 0;
        const authority = createAdmittedRunOperatorAuthority({
          profileId: "pdf-reader",
          scopes: ["operator.write"],
          retain: () => {
            sourceHolds += 1;
            return () => {
              sourceHolds -= 1;
            };
          },
          assertCurrent: () => {
            if (!active) {
              throw new Error("requester retired");
            }
          },
          modelPolicy: prepareOperatorModelPolicy({
            cfg,
            policy: { sourceAgent: "main" },
            manifestPlugins: [],
          }),
        });
        vi.spyOn(pdfExtract, "extractPdfContent").mockImplementation(async () => {
          active = scenario !== "retired after extraction";
          return { text: "Synthetic document text", images: [] };
        });
        completeMock.mockResolvedValue({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Allowed PDF answer." }],
        });
        const pdfTool = (await import("./pdf-tool.js")).createPdfTool({
          config: cfg,
          agentDir: runtimeAgentDir,
        });
        if (!pdfTool) {
          throw new Error("expected PDF tool");
        }
        const runWithRequester = <T>(run: () => Promise<T>) =>
          source === "direct"
            ? withOperatorToolGatewayAuthority(
                { scopes: ["operator.write"], operatorRunAuthority: authority },
                run,
              )
            : withGatewayToolCallerIdentity(
                { agentId: "main", sessionKey: "agent:main:reader", operatorAuthority: authority },
                run,
              );
        const changedDuringCapture = scenario === "mutated override" || scenario === "mutated path";
        const captureStarted = createDeferredCore();
        const resumeCapture = createDeferredCore();
        const capture = operatorInvocation.captureAmbientGatewayOperatorAuthority;
        const captureSpy = changedDuringCapture
          ? vi
              .spyOn(operatorInvocation, "captureAmbientGatewayOperatorAuthority")
              .mockImplementation(async (params) => {
                const retained = await capture(params);
                captureStarted.resolve();
                await resumeCapture.promise;
                return retained;
              })
          : undefined;
        const args = {
          pdfs: ["/tmp/synthetic.pdf"],
          prompt: "Answer using this PDF.",
          model:
            scenario === "denied override" || scenario === "mutated override"
              ? "blocked-alias"
              : undefined,
        };
        const work = new AsyncWorkScope();
        try {
          const execution = work.track(() =>
            runWithRequester(() => pdfTool.execute("policy", args)),
          );
          if (changedDuringCapture) {
            await Promise.race([captureStarted.promise, execution]);
            args.model = scenario === "mutated override" ? undefined : "blocked-alias";
            args.pdfs[0] = "/tmp/replacement.pdf";
            resumeCapture.resolve();
          }
          if (scenario === "permitted fallback" || scenario === "mutated path") {
            await expect(execution).resolves.toMatchObject({
              content: [{ type: "text", text: "Allowed PDF answer." }],
            });
            expect(completeMock).toHaveBeenCalledOnce();
          } else {
            await expect(execution).rejects.toThrow();
            expect(completeMock).not.toHaveBeenCalled();
          }
          if (scenario === "mutated path") {
            expect(loadSpy).toHaveBeenCalledExactlyOnceWith(
              "/tmp/synthetic.pdf",
              expect.any(Object),
            );
          }
          if (scenario === "denied override" || scenario === "mutated override") {
            expect(loadSpy).not.toHaveBeenCalled();
            expect(preparedRuntime.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
          }
        } finally {
          resumeCapture.resolve();
          await work.drain();
          captureSpy?.mockRestore();
        }
        expect(sourceHolds).toBe(0);
      });
    },
  );

  it.each(["runtime acquisition", "model resolution"])(
    "forwards cancellation to %s before provider work starts",
    async (stage) => {
      await withTempPdfAgentDir(async (runtimeAgentDir) => {
        await stubPdfToolInfra(runtimeAgentDir, { provider: "openai" });
        const cfg = {
          agents: { defaults: { pdfModel: { primary: "openai/gpt-5.4-mini" } } },
        } as OpenClawConfig;
        const cancelled = new Error("PDF runtime cancelled");
        const started = createDeferredCore<AbortSignal | undefined>();
        const pending = createDeferredCore<never>();
        const waitForCancellation = (abortSignal?: AbortSignal) => {
          started.resolve(abortSignal);
          abortSignal?.addEventListener("abort", () => pending.reject(cancelled), { once: true });
          return pending.promise;
        };
        if (stage === "runtime acquisition") {
          vi.mocked(preparedRuntime.acquireAgentRunPreparedModelRuntime).mockImplementationOnce(
            (_input, options) => waitForCancellation(options?.abortSignal),
          );
        } else {
          vi.spyOn(modelResolution, "resolveModelAsync").mockImplementationOnce(
            (_provider, _model, _agentDir, _cfg, options) =>
              waitForCancellation(options?.abortSignal),
          );
        }
        const pdfTool = (await import("./pdf-tool.js")).createPdfTool({
          config: cfg,
          agentDir: runtimeAgentDir,
        });
        if (!pdfTool) {
          throw new Error("expected PDF tool");
        }
        const controller = new AbortController();
        const execution = pdfTool.execute(
          "t1",
          { prompt: "summarize", pdf: "/tmp/a.pdf" },
          controller.signal,
        );
        const assertion =
          stage === "runtime acquisition"
            ? expect(execution).rejects.toMatchObject({
                name: "AbortError",
                message: cancelled.message,
                cause: cancelled,
              })
            : expect(execution).rejects.toBe(cancelled);
        try {
          expect(await started.promise).toBe(controller.signal);
          controller.abort(cancelled);
          await assertion;
          expect(completeMock).not.toHaveBeenCalled();
        } finally {
          controller.abort(cancelled);
          pending.reject(cancelled);
          await assertion;
        }
      });
    },
  );
});
