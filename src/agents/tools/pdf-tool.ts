/**
 * pdf built-in tool.
 *
 * Loads local/web PDFs, extracts pages/text, and analyzes them with native or fallback media-understanding models.
 */
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import type { Context } from "../../llm/types.js";
import { renderDocumentTruncationNotice } from "../../media/document-extraction-metadata.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { extractPdfContent, type PdfExtractedContent } from "../../media/pdf-extract.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveModelAsync } from "../embedded-agent-runner/model.js";
import { abortable } from "../embedded-agent-runner/run/abortable.js";
import { requireApiKey } from "../model-auth.js";
import { resolveAllowedImageFallbackCandidates } from "../model-fallback-image.js";
import type { ModelRef } from "../model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { retainPreparedModelRuntimeSnapshotResources } from "../prepared-model-runtime.resources.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { optionalFiniteNumberSchema } from "../schema/typebox.js";
import { completeWithPreparedSimpleCompletionModel } from "../simple-completion-execution.js";
import { prepareSimpleCompletionModel } from "../simple-completion-runtime.js";
import { readFiniteNumberParam, ToolInputError } from "./common.js";
import { coerceImageModelConfig, type ImageModelConfig } from "./image-tool.helpers.js";
import {
  buildMediaReferenceDetails,
  buildTextToolResult,
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveMediaToolSandboxConfig,
  resolveMediaToolReferenceAccess,
  resolvePromptAndModelOverride,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import { applyAgentDefaultModelConfig, hasToolModelConfig } from "./model-config.helpers.js";
import { anthropicAnalyzePdf, geminiAnalyzePdf } from "./pdf-native-providers.js";
import {
  buildPdfExtractionContext,
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfInputs,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
import {
  createSandboxBridgeReadFile,
  runWithImageModelFallback,
  type AnyAgentTool,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Analyze this PDF document.";
const DEFAULT_MAX_PDFS = 10;
const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 20;

const PDF_MIN_TEXT_CHARS = 200;
const PDF_MAX_PIXELS = 4_000_000;

const PdfToolSchema = Type.Object({
  prompt: Type.Optional(Type.String()),
  pdf: Type.Optional(Type.String({ description: "One PDF path/URL." })),
  pdfs: Type.Optional(
    Type.Array(Type.String(), {
      description: "PDF paths/URLs; max 10.",
    }),
  ),
  pages: Type.Optional(
    Type.String({
      description: 'Pages, e.g. "1-5", "1,3,5-7"; default all, up to configured limit.',
    }),
  ),
  password: Type.Optional(Type.String({ description: "Password for encrypted PDFs." })),
  model: Type.Optional(Type.String()),
  maxBytesMb: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
});

function hasExplicitPdfToolModelConfig(config?: OpenClawConfig): boolean {
  return (
    hasToolModelConfig(coercePdfModelConfig(config)) ||
    hasToolModelConfig(coerceImageModelConfig(config))
  );
}

// ---------------------------------------------------------------------------
// Run PDF prompt with model fallback
// ---------------------------------------------------------------------------

async function runPdfPrompt(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  pdfModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  pdfBuffers: Array<{ buffer: Buffer; filename: string }>;
  password?: string;
  pageNumbers?: number[];
  explicitSelectionLimit?: number;
  getExtractions: () => Promise<PdfExtractedContent[]>;
  signal?: AbortSignal;
  onAcquired: (resource: AsyncDisposable) => void;
  assertResourcesOpen?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  native: boolean;
  extractions: PdfExtractedContent[];
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const requestedCfg = applyAgentDefaultModelConfig(
    params.cfg,
    "imageModel",
    params.pdfModelConfig,
  );

  let preparedRuntime = params.preparedModelRuntime;
  if (!preparedRuntime) {
    const acquireRuntime = trackAsyncWork(async () => {
      const lease = await acquireAgentRunPreparedModelRuntime(
        {
          agentDir: params.agentDir,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          config: requestedCfg ?? {},
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        },
        { abortSignal: params.signal },
      );
      // The execution owns even a late acquisition before setup can admit cleanup work.
      params.onAcquired(lease);
      return lease.snapshot;
    });
    preparedRuntime = params.signal
      ? await abortable(params.signal, acquireRuntime)
      : await acquireRuntime;
  }
  params.signal?.throwIfAborted();
  params.assertResourcesOpen?.();
  const runtimeAgentDir = preparedRuntime.agentDir;
  const runtimeWorkspaceDir = preparedRuntime.workspaceDir ?? params.workspaceDir;
  const committedPdfModelConfig = resolvePdfModelConfigForTool({
    cfg: preparedRuntime.config,
    agentDir: runtimeAgentDir,
    ...(runtimeWorkspaceDir ? { workspaceDir: runtimeWorkspaceDir } : {}),
  });
  if (!committedPdfModelConfig) {
    throw new ToolInputError("No PDF model configured in the active runtime generation.");
  }
  const effectiveCfg = applyAgentDefaultModelConfig(
    preparedRuntime.config,
    "imageModel",
    committedPdfModelConfig,
  );
  let nativePdfs: Array<{ base64: string; filename: string }> | undefined;

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    manifestPlugins: preparedRuntime.metadataSnapshot,
    modelOverride: params.modelOverride,
    operatorAuthority: params.operatorAuthority,
    abortSignal: params.signal,
    run: async (provider, modelId) => {
      let modelForAuthorization: ModelRef | undefined;
      let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
      let modelSignal = params.signal;
      const assertModelCurrent = () => {
        modelSignal?.throwIfAborted();
        params.assertResourcesOpen?.();
        modelExecution?.assertCurrent();
        if (modelForAuthorization) {
          assertOperatorModelAllowed(params.operatorAuthority, modelForAuthorization);
        }
      };
      const resolveAuthorizedModel: typeof resolveModelAsync = async (...args) => {
        const resolved = await resolveModelAsync(...args);
        if (resolved.model) {
          const logicalRef = resolved.logicalRef;
          if (
            !modelForAuthorization ||
            modelForAuthorization.provider !== logicalRef?.provider ||
            modelForAuthorization.model !== logicalRef?.model
          ) {
            modelExecution?.release();
            modelForAuthorization = logicalRef;
            const execution = bindOperatorModelExecution(params.operatorAuthority, logicalRef);
            modelExecution = execution;
            if (execution) {
              params.onAcquired({
                async [Symbol.asyncDispose]() {
                  execution.release();
                },
              });
            }
            modelSignal = execution
              ? params.signal
                ? AbortSignal.any([params.signal, execution.signal])
                : execution.signal
              : params.signal;
          }
          assertModelCurrent();
        }
        return resolved;
      };
      const prepared = await prepareSimpleCompletionModel(
        {
          cfg: effectiveCfg,
          agentId: params.agentId,
          provider,
          modelId,
          modelIdSource: "selected",
          allowBundledStaticCatalogFallback: true,
          skipAgentDiscovery: true,
          allowMissingApiKeyModes: ["aws-sdk"],
          preparedModelRuntime: preparedRuntime,
          workspaceDir: runtimeWorkspaceDir,
          modelResolver: resolveAuthorizedModel,
          signal: params.signal,
        },
        assertModelCurrent,
      );
      assertModelCurrent();
      if (!("model" in prepared)) {
        throw new Error(prepared.error);
      }
      const { model, auth } = prepared;
      const apiKey =
        auth.mode === "aws-sdk" && model.api === "bedrock-converse-stream"
          ? (auth.apiKey ?? "")
          : requireApiKey(auth, model.provider);

      if (providerSupportsNativePdf(provider)) {
        if (params.password) {
          throw new Error(
            `password is not supported with native PDF providers (${provider}/${modelId}). Remove password, or use a non-native model for encrypted PDFs.`,
          );
        }
        if (params.pageNumbers && params.pageNumbers.length > 0) {
          throw new Error(
            `pages is not supported with native PDF providers (${provider}/${modelId}). Remove pages, or use a non-native model for page filtering.`,
          );
        }

        // Encode only native requests, once across retries, after checking cancellation.
        assertModelCurrent();
        const pdfs = (nativePdfs ??= params.pdfBuffers.map(({ buffer, filename }) => ({
          base64: buffer.toString("base64"),
          filename,
        })));

        const analyzePdf =
          provider === "anthropic"
            ? anthropicAnalyzePdf
            : provider === "google"
              ? geminiAnalyzePdf
              : undefined;
        if (analyzePdf) {
          const text = await analyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            ...(provider === "anthropic"
              ? { maxTokens: resolvePdfToolMaxTokens(model.maxTokens) }
              : {}),
            baseUrl: model.baseUrl,
            requestConfig: {
              headers: model.headers,
              request: getModelProviderRequestTransport(model),
            },
            signal: modelSignal,
          });
          assertModelCurrent();
          return { text, provider, model: modelId, native: true, extractions: [] };
        }
      }

      const extractions = await params.getExtractions();
      const completeExtraction = async (context: Context) => {
        // A run cancelled mid-dispatch must not buy another provider call.
        assertModelCurrent();
        const completion = trackAsyncWork(() =>
          completeWithPreparedSimpleCompletionModel({
            model,
            auth,
            context,
            cfg: effectiveCfg,
            options: {
              maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
              signal: modelSignal,
            },
            assertCurrent: assertModelCurrent,
          }),
        );
        const message = modelSignal ? await abortable(modelSignal, completion) : await completion;
        assertModelCurrent();
        return message;
      };
      let effectiveExtractions = extractions;
      const hasImages = extractions.some((e) => e.images.length > 0);
      if (hasImages && !model.input?.includes("image")) {
        const hasText = extractions.some((e) => e.text.trim().length > 0);
        if (!hasText) {
          throw new Error(
            `Model ${provider}/${modelId} does not support images and PDF has no extractable text.`,
          );
        }
        effectiveExtractions = extractions.map((extraction) =>
          extraction.images.length > 0
            ? {
                text: extraction.text,
                images: [],
                metadata: {
                  ...extraction.metadata,
                  textTruncated: extraction.metadata?.textTruncated ?? false,
                  imagesTruncated: true,
                },
              }
            : extraction,
        );
      }

      const context = buildPdfExtractionContext(
        params.prompt,
        effectiveExtractions,
        params.explicitSelectionLimit,
        model,
      );
      const message = await completeExtraction(context);
      const text = coercePdfAssistantText({ message, provider, model: modelId });
      return { text, provider, model: modelId, native: false, extractions: effectiveExtractions };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    native: result.result.native,
    extractions: result.result.extractions,
    attempts: result.attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      error: a.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// PDF tool factory
// ---------------------------------------------------------------------------

export function createPdfTool(options?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  workspaceDir?: string;
  cwd?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MediaToolSandbox;
  fsPolicy?: ToolFsPolicy;
  /**
   * Avoid resolving auto PDF-provider/model candidates while registering the
   * tool. The concrete PDF model is still resolved before execution.
   */
  deferAutoModelResolution?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  const hasExplicitModelConfig = hasExplicitPdfToolModelConfig(options?.config);
  if (!agentDir) {
    if (hasExplicitModelConfig) {
      throw new Error("createPdfTool requires agentDir when enabled");
    }
    return null;
  }

  const shouldDeferAutoModelResolution =
    options?.deferAutoModelResolution === true && !hasExplicitModelConfig;
  const registrationPdfModelConfig = shouldDeferAutoModelResolution
    ? null
    : resolvePdfModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
      });
  if (!registrationPdfModelConfig && !shouldDeferAutoModelResolution) {
    return null;
  }

  const maxBytesMbDefault = options?.config?.agents?.defaults?.pdfMaxMb;
  const maxPagesDefault = options?.config?.agents?.defaults?.pdfMaxPages;
  const configuredMaxBytesMb =
    typeof maxBytesMbDefault === "number" && Number.isFinite(maxBytesMbDefault)
      ? maxBytesMbDefault
      : DEFAULT_MAX_BYTES_MB;
  const configuredMaxPages =
    typeof maxPagesDefault === "number" && Number.isFinite(maxPagesDefault)
      ? Math.floor(maxPagesDefault)
      : DEFAULT_MAX_PAGES;

  const description =
    'Analyze PDF(s): Anthropic/Google native when supported, else text/image extraction. pdf one; pdfs max 10; prompt says inspection. `pages` selects up to the configured page limit from a range ("1-5", "1,3,5-7"); `password` opens encrypted PDFs (both non-native only).';
  const remoteMediaSsrfPolicy = options?.config?.tools?.web?.fetch?.ssrfPolicy;

  const executePdf = async (
    record: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onAcquired: (resource: AsyncDisposable) => void,
    assertResourcesOpen: (() => void) | undefined,
    operatorAuthority: AdmittedRunOperatorAuthority | undefined,
  ): Promise<Awaited<ReturnType<AnyAgentTool["execute"]>>> => {
    // MARK: - Normalize pdf + pdfs input
    const pdfInputs = resolvePdfInputs(record);

    // Enforce max PDFs cap
    if (pdfInputs.length > DEFAULT_MAX_PDFS) {
      return {
        content: [
          {
            type: "text",
            text: `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`,
          },
        ],
        details: {
          error: "too_many_pdfs",
          count: pdfInputs.length,
          max: DEFAULT_MAX_PDFS,
        },
      };
    }

    const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(
      record,
      DEFAULT_PROMPT,
    );
    const maxBytesMb =
      readFiniteNumberParam(record, "maxBytesMb", {
        min: 0,
        minExclusive: true,
        message: "maxBytesMb must be greater than 0",
      }) ?? configuredMaxBytesMb;
    const maxBytes = Math.floor(maxBytesMb * 1024 * 1024);

    // Parse page range
    const pagesRaw = normalizeOptionalString(record.pages);
    const pageSelection = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : undefined;
    const pageNumbers = pageSelection?.pages;
    const password = typeof record.password === "string" ? record.password : undefined;

    const pdfModelConfig =
      registrationPdfModelConfig ??
      resolvePdfModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
      });
    if (!pdfModelConfig) {
      throw new ToolInputError("No PDF model configured.");
    }
    resolveAllowedImageFallbackCandidates({
      cfg: applyAgentDefaultModelConfig(options?.config, "imageModel", pdfModelConfig),
      modelOverride,
      manifestPlugins: options?.preparedModelRuntime?.metadataSnapshot,
      operatorAuthority,
    });

    const sandboxConfig = resolveMediaToolSandboxConfig(
      options?.sandbox,
      options?.fsPolicy?.workspaceOnly,
    );

    // MARK: - Load each PDF
    const loadedPdfs: Array<{
      buffer: Buffer;
      filename: string;
      resolvedPath: string;
      rewrittenFrom?: string;
    }> = [];

    for (const pdfRaw of pdfInputs) {
      // Stop before starting the next sequential download when the run was
      // aborted, so a dead run cannot keep pulling remote PDFs.
      signal?.throwIfAborted();
      const trimmed = normalizeMediaReferenceSource(pdfRaw);
      const refInfo = classifyMediaReferenceSource(trimmed, { allowDataUrl: false });
      const { isHttpUrl } = refInfo;

      if (refInfo.hasUnsupportedScheme) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported PDF reference: ${pdfRaw}. Use a file path, file:// URL, or http(s) URL.`,
            },
          ],
          details: { error: "unsupported_pdf_reference", pdf: pdfRaw },
        };
      }

      if (sandboxConfig && isHttpUrl) {
        throw new Error("Sandboxed PDF tool does not allow remote URLs.");
      }

      const { resolvedPath, localRoots, rewrittenFrom } = await resolveMediaToolReferenceAccess({
        input: trimmed,
        isDataUrl: false,
        workspaceDir: options?.workspaceDir,
        cwd: options?.cwd,
        fsPolicy: options?.fsPolicy,
        sandbox: sandboxConfig,
      });
      if (resolvedPath === null) {
        throw new Error("PDF reference resolved without a path.");
      }

      const media = sandboxConfig
        ? await loadWebMediaRaw(resolvedPath, {
            maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
          })
        : await loadWebMediaRaw(resolvedPath, {
            maxBytes,
            localRoots,
            ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
            ...(isHttpUrl ? { readIdleTimeoutMs: REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS } : {}),
            ssrfPolicy: remoteMediaSsrfPolicy,
            // Forward the run abort signal into the fetch layer so an abort
            // mid-download disconnects the in-flight socket.
            ...(signal ? { requestInit: { signal } } : {}),
          });

      if (normalizeMimeType(media.contentType) !== "application/pdf") {
        throw new Error(`Expected PDF but got ${media.contentType ?? media.kind}: ${pdfRaw}`);
      }

      const filename =
        media.fileName ??
        (isHttpUrl
          ? (new URL(trimmed).pathname.split("/").pop() ?? "document.pdf")
          : "document.pdf");

      loadedPdfs.push({
        buffer: media.buffer,
        filename,
        resolvedPath,
        ...(rewrittenFrom ? { rewrittenFrom } : {}),
      });
    }

    let extractionCache: PdfExtractedContent[] | undefined;
    const getExtractions = async (): Promise<PdfExtractedContent[]> => {
      if (extractionCache) {
        return extractionCache;
      }
      const extractedAll: PdfExtractedContent[] = [];
      for (const pdf of loadedPdfs) {
        // Extraction is sequential and can be CPU-heavy. Do not start the next
        // document after the owning agent run has been cancelled.
        signal?.throwIfAborted();
        const extracted = await extractPdfContent({
          ...(signal ? { signal } : {}),
          buffer: pdf.buffer,
          maxPages: configuredMaxPages,
          maxPixels: PDF_MAX_PIXELS,
          minTextChars: PDF_MIN_TEXT_CHARS,
          ...(password ? { password } : {}),
          pageNumbers,
          config: options?.config,
        });
        extractedAll.push(extracted);
      }
      extractionCache = extractedAll;
      return extractionCache;
    };

    // Do not issue a paid PDF-model call for an already-aborted run.
    signal?.throwIfAborted();
    const { extractions: completedExtractions, ...result } = await runPdfPrompt({
      onAcquired,
      assertResourcesOpen,
      operatorAuthority,
      signal,
      cfg: options?.config,
      agentId: options?.agentId,
      agentDir,
      ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      ...(options?.preparedModelRuntime
        ? { preparedModelRuntime: options.preparedModelRuntime }
        : {}),
      pdfModelConfig,
      modelOverride,
      prompt: promptRaw,
      pdfBuffers: loadedPdfs,
      ...(password ? { password } : {}),
      pageNumbers,
      ...(pageSelection?.truncated ? { explicitSelectionLimit: pageSelection.pages.length } : {}),
      getExtractions,
    });

    const pdfDetails = buildMediaReferenceDetails({
      entries: loadedPdfs,
      singleKey: "pdf",
      pluralKey: "pdfs",
      getResolvedInput: (pdf) => pdf.resolvedPath,
    });

    const truncationNotices = result.native
      ? []
      : completedExtractions.flatMap((extraction, index) => {
          const notice = renderDocumentTruncationNotice(
            extraction.metadata,
            pageSelection?.truncated ? pageSelection.pages.length : undefined,
          );
          return notice ? (loadedPdfs.length > 1 ? `PDF ${index + 1}: ${notice}` : notice) : [];
        });
    const text = [...truncationNotices, result.text].join("\n");
    return buildTextToolResult({ ...result, text }, { native: result.native, ...pdfDetails });
  };

  return {
    label: "PDF",
    name: "pdf",
    description,
    parameters: PdfToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const record: Record<string, unknown> = args && typeof args === "object" ? { ...args } : {};
      if (Array.isArray(record.pdfs)) {
        record.pdfs = [...record.pdfs];
      }
      return runWithAsyncWorkResources(async (onAcquired) => {
        const runtimeResources = new AsyncDisposableStack();
        const capturedOperator = await captureAmbientGatewayOperatorAuthority({
          missingBindingError: () =>
            new Error("PDF analysis requires its current Gateway binding."),
          retainInherited: true,
        });
        const releaseOperator = capturedOperator.release;
        onAcquired({
          release: async () => {
            try {
              await runtimeResources.disposeAsync();
            } finally {
              releaseOperator?.();
            }
          },
        });
        const operatorAuthority = capturedOperator.authority;
        const executionSignal = operatorAuthority?.signal
          ? signal
            ? AbortSignal.any([signal, operatorAuthority.signal])
            : operatorAuthority.signal
          : signal;
        capturedOperator.assertInvocationCurrent?.();
        operatorAuthority?.assertCurrent();
        const suppliedClaim = options?.preparedModelRuntime
          ? retainPreparedModelRuntimeSnapshotResources(options.preparedModelRuntime)
          : undefined;
        if (suppliedClaim) {
          runtimeResources.defer(() => suppliedClaim.release());
        }
        return executePdf(
          record,
          executionSignal,
          (resource) => {
            runtimeResources.use(resource);
          },
          () => {
            capturedOperator.assertInvocationCurrent?.();
            operatorAuthority?.assertCurrent();
            suppliedClaim?.assertOpen();
            executionSignal?.throwIfAborted();
          },
          operatorAuthority,
        );
      });
    },
  };
}
