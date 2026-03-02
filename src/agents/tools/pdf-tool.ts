import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { InputImageContent } from "../../media/input-files.js";
import { resolveUserPath } from "../../utils.js";
import { getDefaultLocalRoots, loadWebMediaRaw } from "../../web/media.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { getApiKeyForModel, requireApiKey, resolveEnvApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { resolveConfiguredModelRef } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type SandboxedBridgeMediaPathConfig,
} from "../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { normalizeWorkspaceDir } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { anthropicAnalyzePdf, geminiAnalyzePdf } from "./pdf-native-providers.js";
import {
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";

const DEFAULT_PROMPT = "Analyze this PDF document.";
const DEFAULT_MAX_PDFS = 10;
const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 20;
const ANTHROPIC_PDF_PRIMARY = "anthropic/claude-opus-4-6";
const ANTHROPIC_PDF_FALLBACK = "anthropic/claude-opus-4-5";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type CanvasModule = typeof import("@napi-rs/canvas");

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let canvasModulePromise: Promise<CanvasModule> | null = null;

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      pdfJsModulePromise = null;
      throw new Error(
        `Optional dependency pdfjs-dist is required for PDF extraction: ${String(err)}`,
      );
    });
  }
  return pdfJsModulePromise;
}

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
      canvasModulePromise = null;
      throw new Error(
        `Optional dependency @napi-rs/canvas is required for PDF image extraction: ${String(err)}`,
      );
    });
  }
  return canvasModulePromise;
}

const PDF_MIN_TEXT_CHARS = 200;
const PDF_MAX_PIXELS = 4_000_000;

type PdfExtractedContent = {
  text: string;
  images: InputImageContent[];
};

/**
 * Extract text and/or rasterized images from a PDF buffer.
 * Supports optional page range filtering.
 */
async function extractPdfContent(params: {
  buffer: Buffer;
  maxPages: number;
  pageNumbers?: number[];
}): Promise<PdfExtractedContent> {
  const { buffer, maxPages, pageNumbers } = params;
  const { getDocument } = await loadPdfJsModule();
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
  }).promise;

  // Determine which pages to process
  const effectivePages: number[] = pageNumbers
    ? pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, maxPages)
    : Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => i + 1);

  const textParts: string[] = [];
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      textParts.push(pageText);
    }
  }

  const text = textParts.join("\n\n");

  // If the PDF has enough text, use text-only path
  if (text.trim().length >= PDF_MIN_TEXT_CHARS) {
    return { text, images: [] };
  }

  // Otherwise, rasterize pages to images (scanned/image-heavy PDF)
  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch {
    // Canvas not available; return whatever text we have
    return { text, images: [] };
  }
  const { createCanvas } = canvasModule;
  const images: InputImageContent[] = [];
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pagePixels = viewport.width * viewport.height;
    const scale = Math.min(1, Math.sqrt(PDF_MAX_PIXELS / Math.max(1, pagePixels)));
    const scaled = page.getViewport({ scale: Math.max(0.1, scale) });
    const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }

  return { text, images };
}

// ---------------------------------------------------------------------------
// Model resolution (mirrors image tool pattern)
// ---------------------------------------------------------------------------

function resolveDefaultModelRef(cfg?: OpenClawConfig): { provider: string; model: string } {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

function hasAuthForProvider(params: { provider: string; agentDir: string }): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  return listProfilesForProvider(store, params.provider).length > 0;
}

/**
 * Resolve the effective PDF model config.
 * Falls back to the image model config, then to provider-specific defaults.
 */
export function resolvePdfModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
}): ImageModelConfig | null {
  // Check for explicit PDF model config first
  const explicitPdf = coercePdfModelConfig(params.cfg);
  if (explicitPdf.primary?.trim() || (explicitPdf.fallbacks?.length ?? 0) > 0) {
    return explicitPdf;
  }

  // Fall back to the image model config
  const explicitImage = coerceImageModelConfig(params.cfg);
  if (explicitImage.primary?.trim() || (explicitImage.fallbacks?.length ?? 0) > 0) {
    return explicitImage;
  }

  // Auto-detect from available providers
  const primary = resolveDefaultModelRef(params.cfg);
  const anthropicOk = hasAuthForProvider({ provider: "anthropic", agentDir: params.agentDir });
  const googleOk = hasAuthForProvider({ provider: "google", agentDir: params.agentDir });
  const openaiOk = hasAuthForProvider({ provider: "openai", agentDir: params.agentDir });

  const fallbacks: string[] = [];
  const addFallback = (ref: string) => {
    const trimmed = ref.trim();
    if (trimmed && !fallbacks.includes(trimmed)) {
      fallbacks.push(trimmed);
    }
  };

  // Prefer providers with native PDF support
  let preferred: string | null = null;

  const providerOk = hasAuthForProvider({ provider: primary.provider, agentDir: params.agentDir });
  const providerVision = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });

  if (primary.provider === "anthropic" && anthropicOk) {
    preferred = ANTHROPIC_PDF_PRIMARY;
  } else if (primary.provider === "google" && googleOk && providerVision) {
    preferred = providerVision;
  } else if (providerOk && providerVision) {
    preferred = providerVision;
  } else if (anthropicOk) {
    preferred = ANTHROPIC_PDF_PRIMARY;
  } else if (googleOk) {
    preferred = "google/gemini-2.5-pro";
  } else if (openaiOk) {
    preferred = "openai/gpt-5-mini";
  }

  if (preferred?.trim()) {
    if (anthropicOk && preferred !== ANTHROPIC_PDF_PRIMARY) {
      addFallback(ANTHROPIC_PDF_PRIMARY);
    }
    if (anthropicOk) {
      addFallback(ANTHROPIC_PDF_FALLBACK);
    }
    if (openaiOk) {
      addFallback("openai/gpt-5-mini");
    }
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return { primary: preferred, ...(pruned.length > 0 ? { fallbacks: pruned } : {}) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Build context for extraction fallback path
// ---------------------------------------------------------------------------

function buildPdfExtractionContext(prompt: string, extractions: PdfExtractedContent[]): Context {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];

  // Add extracted text and images
  for (let i = 0; i < extractions.length; i++) {
    const extraction = extractions[i];
    if (extraction.text.trim()) {
      const label = extractions.length > 1 ? `[PDF ${i + 1} text]\n` : "[PDF text]\n";
      content.push({ type: "text", text: label + extraction.text });
    }
    for (const img of extraction.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  // Add the user prompt
  content.push({ type: "text", text: prompt });

  return {
    messages: [{ role: "user", content, timestamp: Date.now() }],
  };
}

// ---------------------------------------------------------------------------
// Run PDF prompt with model fallback
// ---------------------------------------------------------------------------

type PdfSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function runPdfPrompt(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  pdfModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  pdfBuffers: Array<{ base64: string; filename: string }>;
  extractions: PdfExtractedContent[];
}): Promise<{
  text: string;
  provider: string;
  model: string;
  native: boolean;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg: OpenClawConfig | undefined = params.cfg
    ? {
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          defaults: {
            ...params.cfg.agents?.defaults,
            imageModel: params.pdfModelConfig,
          },
        },
      }
    : undefined;

  await ensureOpenClawModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
      if (!model) {
        throw new Error(`Unknown model: ${provider}/${modelId}`);
      }

      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
      });
      const apiKey = requireApiKey(apiKeyInfo, model.provider);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      // Try native PDF path for supported providers
      if (providerSupportsNativePdf(provider)) {
        const pdfs = params.pdfBuffers.map((p) => ({
          base64: p.base64,
          filename: p.filename,
        }));

        if (provider === "anthropic") {
          const text = await anthropicAnalyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
            baseUrl: model.baseUrl,
          });
          return { text, provider, model: modelId, native: true };
        }

        if (provider === "google") {
          const text = await geminiAnalyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            baseUrl: model.baseUrl,
          });
          return { text, provider, model: modelId, native: true };
        }
      }

      // Extraction fallback: check the model can handle images or text
      const hasImages = params.extractions.some((e) => e.images.length > 0);
      if (hasImages && !model.input?.includes("image")) {
        // Model can't handle images; check if we have enough text
        const hasText = params.extractions.some((e) => e.text.trim().length > 0);
        if (!hasText) {
          throw new Error(
            `Model ${provider}/${modelId} does not support images and PDF has no extractable text.`,
          );
        }
        // Strip images, use text-only
        const textOnlyExtractions = params.extractions.map((e) => ({
          text: e.text,
          images: [] as InputImageContent[],
        }));
        const context = buildPdfExtractionContext(params.prompt, textOnlyExtractions);
        const message = await complete(model, context, {
          apiKey,
          maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
        });
        const text = coercePdfAssistantText({ message, provider, model: modelId });
        return { text, provider, model: modelId, native: false };
      }

      const context = buildPdfExtractionContext(params.prompt, params.extractions);
      const message = await complete(model, context, {
        apiKey,
        maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
      });
      const text = coercePdfAssistantText({ message, provider, model: modelId });
      return { text, provider, model: modelId, native: false };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    native: result.result.native,
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
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: PdfSandboxConfig;
  fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    const explicit = coercePdfModelConfig(options?.config);
    if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
      throw new Error("createPdfTool requires agentDir when enabled");
    }
    return null;
  }

  const pdfModelConfig = resolvePdfModelConfigForTool({ cfg: options?.config, agentDir });
  if (!pdfModelConfig) {
    return null;
  }

  const maxBytesMbDefault = (
    options?.config?.agents?.defaults as Record<string, unknown> | undefined
  )?.pdfMaxBytesMb;
  const maxPagesDefault = (options?.config?.agents?.defaults as Record<string, unknown> | undefined)
    ?.pdfMaxPages;
  const configuredMaxBytesMb =
    typeof maxBytesMbDefault === "number" && Number.isFinite(maxBytesMbDefault)
      ? maxBytesMbDefault
      : DEFAULT_MAX_BYTES_MB;
  const configuredMaxPages =
    typeof maxPagesDefault === "number" && Number.isFinite(maxPagesDefault)
      ? Math.floor(maxPagesDefault)
      : DEFAULT_MAX_PAGES;

  const localRoots = (() => {
    const roots = getDefaultLocalRoots();
    const workspaceDir = normalizeWorkspaceDir(options?.workspaceDir);
    if (!workspaceDir) {
      return roots;
    }
    return Array.from(new Set([...roots, workspaceDir]));
  })();

  const description =
    "Analyze one or more PDF documents with a model. Supports native PDF analysis for Anthropic and Google models, with text/image extraction fallback for other providers. Use pdf for a single path/URL, or pdfs for multiple (up to 10). Provide a prompt describing what to analyze.";

  return {
    label: "PDF",
    name: "pdf",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      pdf: Type.Optional(Type.String({ description: "Single PDF path or URL." })),
      pdfs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple PDF paths or URLs (up to 10).",
        }),
      ),
      pages: Type.Optional(
        Type.String({
          description: 'Page range to process, e.g. "1-5", "1,3,5-7". Defaults to all pages.',
        }),
      ),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // MARK: - Normalize pdf + pdfs input
      const pdfCandidates: string[] = [];
      if (typeof record.pdf === "string") {
        pdfCandidates.push(record.pdf);
      }
      if (Array.isArray(record.pdfs)) {
        pdfCandidates.push(...record.pdfs.filter((v): v is string => typeof v === "string"));
      }

      const seenPdfs = new Set<string>();
      const pdfInputs: string[] = [];
      for (const candidate of pdfCandidates) {
        const trimmed = candidate.trim();
        if (!trimmed || seenPdfs.has(trimmed)) {
          continue;
        }
        seenPdfs.add(trimmed);
        pdfInputs.push(trimmed);
      }
      if (pdfInputs.length === 0) {
        throw new Error("pdf required: provide a path or URL to a PDF document");
      }

      // Enforce max PDFs cap
      if (pdfInputs.length > DEFAULT_MAX_PDFS) {
        return {
          content: [
            {
              type: "text",
              text: `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`,
            },
          ],
          details: { error: "too_many_pdfs", count: pdfInputs.length, max: DEFAULT_MAX_PDFS },
        };
      }

      const promptRaw =
        typeof record.prompt === "string" && record.prompt.trim()
          ? record.prompt.trim()
          : DEFAULT_PROMPT;
      const modelOverride =
        typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
      const maxBytesMbRaw = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytesMb =
        typeof maxBytesMbRaw === "number" && Number.isFinite(maxBytesMbRaw) && maxBytesMbRaw > 0
          ? maxBytesMbRaw
          : configuredMaxBytesMb;
      const maxBytes = Math.floor(maxBytesMb * 1024 * 1024);

      // Parse page range
      const pagesRaw =
        typeof record.pages === "string" && record.pages.trim() ? record.pages.trim() : undefined;

      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options.sandbox.root.trim()
          ? {
              root: options.sandbox.root.trim(),
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Load each PDF
      const loadedPdfs: Array<{
        base64: string;
        buffer: Buffer;
        filename: string;
        resolvedPath: string;
        rewrittenFrom?: string;
      }> = [];

      for (const pdfRaw of pdfInputs) {
        const trimmed = pdfRaw.trim();
        const isHttpUrl = /^https?:\/\//i.test(trimmed);
        const isFileUrl = /^file:/i.test(trimmed);
        const isDataUrl = /^data:/i.test(trimmed);
        const looksLikeWindowsDrive = /^[a-zA-Z]:[\\/]/.test(trimmed);
        const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);

        if (hasScheme && !looksLikeWindowsDrive && !isFileUrl && !isHttpUrl && !isDataUrl) {
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

        const resolvedPdf = (() => {
          if (sandboxConfig) {
            return trimmed;
          }
          if (trimmed.startsWith("~")) {
            return resolveUserPath(trimmed);
          }
          return trimmed;
        })();

        const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = sandboxConfig
          ? await resolveSandboxedBridgeMediaPath({
              sandbox: sandboxConfig,
              mediaPath: resolvedPdf,
              inboundFallbackDir: "media/inbound",
            })
          : {
              resolved: resolvedPdf.startsWith("file://")
                ? resolvedPdf.slice("file://".length)
                : resolvedPdf,
            };

        const media = sandboxConfig
          ? await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              sandboxValidated: true,
              readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
            })
          : await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              localRoots,
            });

        if (media.kind !== "document") {
          // Check MIME type more specifically
          const ct = (media.contentType ?? "").toLowerCase();
          if (!ct.includes("pdf") && !ct.includes("application/pdf")) {
            throw new Error(`Expected PDF but got ${media.contentType ?? media.kind}: ${pdfRaw}`);
          }
        }

        const base64 = media.buffer.toString("base64");
        const filename =
          media.fileName ??
          (isHttpUrl
            ? (new URL(trimmed).pathname.split("/").pop() ?? "document.pdf")
            : "document.pdf");

        loadedPdfs.push({
          base64,
          buffer: media.buffer,
          filename,
          resolvedPath: resolvedPathInfo.resolved,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      // MARK: - Extract content for fallback path (done upfront)
      const pageNumbers = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : undefined;

      const extractions: PdfExtractedContent[] = [];
      for (const pdf of loadedPdfs) {
        const extracted = await extractPdfContent({
          buffer: pdf.buffer,
          maxPages: configuredMaxPages,
          pageNumbers,
        });
        extractions.push(extracted);
      }

      // MARK: - Run model prompt
      const result = await runPdfPrompt({
        cfg: options?.config,
        agentDir,
        pdfModelConfig,
        modelOverride,
        prompt: promptRaw,
        pdfBuffers: loadedPdfs.map((p) => ({ base64: p.base64, filename: p.filename })),
        extractions,
      });

      const pdfDetails =
        loadedPdfs.length === 1
          ? {
              pdf: loadedPdfs[0].resolvedPath,
              ...(loadedPdfs[0].rewrittenFrom
                ? { rewrittenFrom: loadedPdfs[0].rewrittenFrom }
                : {}),
            }
          : {
              pdfs: loadedPdfs.map((p) => ({
                pdf: p.resolvedPath,
                ...(p.rewrittenFrom ? { rewrittenFrom: p.rewrittenFrom } : {}),
              })),
            };

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          model: `${result.provider}/${result.model}`,
          native: result.native,
          ...pdfDetails,
          attempts: result.attempts,
        },
      };
    },
  };
}
