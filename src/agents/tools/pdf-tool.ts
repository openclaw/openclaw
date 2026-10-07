import { normalizeMimeType } from "@openclaw/media-core/mime";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { providerSupportsNativePdfDocument } from "../../media-understanding/defaults.js";
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
import {
  resolveAllowedImageFallbackCandidates,
  runWithImageModelFallback,
} from "../model-fallback-image.js";
import type { ModelRef } from "../model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { retainPreparedModelRuntimeSnapshotResources } from "../prepared-model-runtime.resources.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { optionalFiniteNumberSchema } from "../schema/typebox.js";
import { completeWithPreparedSimpleCompletionModel } from "../simple-completion-execution.js";
import { prepareSimpleCompletionModel } from "../simple-completion-runtime.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { readFiniteNumberParam, textResult, ToolInputError, type AnyAgentTool } from "./common.js";
import { coerceImageModelConfig } from "./image-tool.helpers.js";
import {
  buildMediaReferenceDetails,
  buildTextToolResult,
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveMediaToolSandboxConfig,
  resolveMediaToolReferenceAccess,
  resolvePromptAndModelOverride,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import {
  applyAgentDefaultModelConfig,
  hasToolModelConfig,
  prepareToolAuthProfileStoreSource,
} from "./model-config.helpers.js";
import { anthropicAnalyzePdf, geminiAnalyzePdf } from "./pdf-native-providers.js";
import {
  buildPdfExtractionContext,
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  resolvePdfInputs,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";
import { type PdfToolActiveModel, resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";

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

export function createPdfTool(options?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  workspaceDir?: string;
  cwd?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MediaToolSandbox;
  fsPolicy?: ToolFsPolicy;
  activeModel?: PdfToolActiveModel;
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
        authProfileStoreSource: options?.authProfileStoreSource,
        activeModel: options?.activeModel,
      });
  if (!registrationPdfModelConfig && !shouldDeferAutoModelResolution) {
    return null;
  }

  const maxBytesMbDefault = options?.config?.agents?.defaults?.pdfMaxMb;
  const maxPagesDefault = options?.config?.agents?.defaults?.pdfMaxPages;
  const configuredMaxBytesMb = asFiniteNumber(maxBytesMbDefault) ?? DEFAULT_MAX_BYTES_MB;
  const configuredMaxPages = Math.floor(asFiniteNumber(maxPagesDefault) ?? DEFAULT_MAX_PAGES);

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
    const pdfInputs = resolvePdfInputs(record);

    if (pdfInputs.length > DEFAULT_MAX_PDFS) {
      return textResult(
        `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`,
        { error: "too_many_pdfs", count: pdfInputs.length, max: DEFAULT_MAX_PDFS },
      );
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

    const pagesRaw = normalizeOptionalString(record.pages);
    const pageSelection = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : undefined;
    const pageNumbers = pageSelection?.pages;
    const password = typeof record.password === "string" ? record.password : undefined;

    let pdfModelConfig = registrationPdfModelConfig;
    let authProfileStoreSource = options?.authProfileStoreSource;
    if (!pdfModelConfig) {
      authProfileStoreSource = await prepareToolAuthProfileStoreSource(options);
      signal?.throwIfAborted();
      assertResourcesOpen?.();
      operatorAuthority?.assertCurrent();
      pdfModelConfig = resolvePdfModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
        authProfileStoreSource,
        activeModel: options?.activeModel,
      });
    }
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

    const loadedPdfs: Array<{
      buffer: Buffer;
      resolvedInput: string;
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
        return textResult(
          `Unsupported PDF reference: ${pdfRaw}. Use a file path, file:// URL, or http(s) URL.`,
          { error: "unsupported_pdf_reference", pdf: pdfRaw },
        );
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

      loadedPdfs.push({
        buffer: media.buffer,
        resolvedInput: resolvedPath,
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
    const {
      config: requestedConfig,
      agentId,
      workspaceDir: configuredWorkspaceDir,
      authProfileStore,
      activeModel,
      preparedModelRuntime,
    } = options ?? {};
    const workspaceDir = configuredWorkspaceDir || undefined;
    const explicitSelectionLimit = pageSelection?.truncated
      ? pageSelection.pages.length
      : undefined;
    const requestedCfg = applyAgentDefaultModelConfig(
      requestedConfig,
      "imageModel",
      pdfModelConfig,
    );

    let preparedRuntime = preparedModelRuntime;
    if (!preparedRuntime) {
      const acquireRuntime = trackAsyncWork(async () => {
        const lease = await acquireAgentRunPreparedModelRuntime(
          {
            agentDir,
            ...(agentId ? { agentId } : {}),
            config: requestedCfg ?? {},
            ...(workspaceDir ? { workspaceDir } : {}),
          },
          { abortSignal: signal },
        );
        // The execution owns even a late acquisition before setup can admit cleanup work.
        onAcquired(lease);
        return lease.snapshot;
      });
      preparedRuntime = signal ? await abortable(signal, acquireRuntime) : await acquireRuntime;
    }
    const runtimeAgentDir = preparedRuntime.agentDir;
    const runtimeWorkspaceDir = preparedRuntime.workspaceDir ?? workspaceDir;
    const runtimeAuthProfileStoreSource = hasExplicitPdfToolModelConfig(preparedRuntime.config)
      ? authProfileStoreSource
      : await prepareToolAuthProfileStoreSource({
          agentDir: runtimeAgentDir,
          authProfileStore,
          authProfileStoreSource,
        });
    signal?.throwIfAborted();
    assertResourcesOpen?.();
    const committedPdfModelConfig = resolvePdfModelConfigForTool({
      cfg: preparedRuntime.config,
      agentDir: runtimeAgentDir,
      ...(runtimeWorkspaceDir ? { workspaceDir: runtimeWorkspaceDir } : {}),
      authStore: authProfileStore,
      authProfileStoreSource: runtimeAuthProfileStoreSource,
      activeModel,
    });
    if (!committedPdfModelConfig) {
      throw new ToolInputError("No PDF model configured in the active runtime generation.");
    }
    const effectiveCfg = applyAgentDefaultModelConfig(
      preparedRuntime.config,
      "imageModel",
      committedPdfModelConfig,
    );
    let nativePdfs: Array<{ base64: string }> | undefined;

    const fallbackResult = await runWithImageModelFallback({
      cfg: effectiveCfg,
      manifestPlugins: preparedRuntime.metadataSnapshot,
      modelOverride,
      operatorAuthority,
      abortSignal: signal,
      run: async (provider, modelId) => {
        let modelForAuthorization: ModelRef | undefined;
        let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
        let modelSignal = signal;
        const assertModelCurrent = () => {
          modelSignal?.throwIfAborted();
          assertResourcesOpen?.();
          modelExecution?.assertCurrent();
          if (modelForAuthorization) {
            assertOperatorModelAllowed(operatorAuthority, modelForAuthorization);
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
              const execution = bindOperatorModelExecution(operatorAuthority, logicalRef);
              modelExecution = execution;
              if (execution) {
                onAcquired({
                  async [Symbol.asyncDispose]() {
                    execution.release();
                  },
                });
              }
              modelSignal = execution
                ? signal
                  ? AbortSignal.any([signal, execution.signal])
                  : execution.signal
                : signal;
            }
            assertModelCurrent();
          }
          return resolved;
        };
        const prepared = await prepareSimpleCompletionModel(
          {
            cfg: effectiveCfg,
            agentId,
            provider,
            modelId,
            modelIdSource: "selected",
            allowBundledStaticCatalogFallback: true,
            skipAgentDiscovery: true,
            allowMissingApiKeyModes: ["aws-sdk"],
            preparedModelRuntime: preparedRuntime,
            workspaceDir: runtimeWorkspaceDir,
            modelResolver: resolveAuthorizedModel,
            signal,
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

        if (providerSupportsNativePdfDocument({ providerId: provider })) {
          if (password) {
            throw new Error(
              `password is not supported with native PDF providers (${provider}/${modelId}). Remove password, or use a non-native model for encrypted PDFs.`,
            );
          }
          if (pageNumbers && pageNumbers.length > 0) {
            throw new Error(
              `pages is not supported with native PDF providers (${provider}/${modelId}). Remove pages, or use a non-native model for page filtering.`,
            );
          }

          // Encode only native requests, once across retries, after checking cancellation.
          assertModelCurrent();
          const pdfs = (nativePdfs ??= loadedPdfs.map(({ buffer }) => ({
            base64: buffer.toString("base64"),
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
              prompt: promptRaw,
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

        const extractions = await getExtractions();
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
          promptRaw,
          effectiveExtractions,
          explicitSelectionLimit,
          model,
        );
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
        const text = coercePdfAssistantText({ message, provider, model: modelId });
        return { text, provider, model: modelId, native: false, extractions: effectiveExtractions };
      },
    });

    const { extractions: completedExtractions, ...completionResult } = fallbackResult.result;
    const result = {
      ...completionResult,
      attempts: fallbackResult.attempts.map((a) => ({
        provider: a.provider,
        model: a.model,
        error: a.error,
      })),
    };

    const pdfDetails = buildMediaReferenceDetails(loadedPdfs, "pdf");

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
