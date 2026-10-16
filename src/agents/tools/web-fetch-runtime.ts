import {
  resolveIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { SsrFBlockedError, type LookupFn, type SsrFPolicy } from "../../infra/net/ssrf.js";
import { logDebug } from "../../logger.js";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "../../security/external-content.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { isRecord } from "../../utils.js";
import { extractReadableContent } from "../../web-fetch/content-extractors.runtime.js";
import {
  writePrivateTempFile,
  type PrivateTempFileOptions,
} from "../sessions/tools/private-temp-file.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import type { WebFetchTransport } from "./web-fetch-transport.js";
import {
  extractBasicHtmlContent,
  htmlToMarkdown,
  markdownToText,
  truncateWebFetchText,
  type ExtractMode,
} from "./web-fetch-utils.js";
import {
  normalizeCacheKey,
  readCache,
  readResponseText,
  writeCache,
  type CacheEntry,
} from "./web-shared.js";

type ResolveWebFetchDefinition =
  (typeof import("../../web-fetch/runtime.js"))["resolveWebFetchDefinition"];
type WebFetchProviderFallback = ReturnType<ResolveWebFetchDefinition>;
const loadWebGuardedFetch = createLazyPromise(() => import("./web-guarded-fetch.js"));

const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;
const WEB_FETCH_SPILL_MAX_CHARS = 2_000_000;
// Titles and warnings are display metadata: 256 chars each is ample. Their
// shared wrapped allowance leaves at least half of maxChars for page content.
const WEB_FETCH_FIELD_MAX_CHARS = 256;
const WEB_FETCH_METADATA_MAX_CHARS = 512;
// Keep URLs whole for tool chaining, matching the fetch-provider URL bound.
const WEB_FETCH_RESULT_URL_MAX_CHARS = 2_048;

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const HOST_FETCH_CACHES = new WeakMap<object, typeof FETCH_CACHE>();

function looksLikeHtml(value: string): boolean {
  const head = normalizeLowercaseStringOrEmpty(value.trimStart().slice(0, 256));
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
}): string {
  const { detail, contentType } = params;
  if (!detail) {
    return "";
  }
  let text = detail;
  const contentTypeLower = normalizeOptionalLowercaseString(contentType);
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text;
    text = markdownToText(withTitle);
  }
  return truncateWebFetchText(text.trim(), DEFAULT_ERROR_MAX_CHARS).text;
}

function redactUrlForDebugLog(rawUrl: string): string {
  const parsed = URL.parse(rawUrl);
  if (!parsed) {
    return "[invalid-url]";
  }
  return parsed.pathname && parsed.pathname !== "/" ? `${parsed.origin}/...` : parsed.origin;
}

const WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD = wrapWebContent("", "web_fetch").length;
const WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD = wrapExternalContent("", {
  source: "web_fetch",
  includeWarning: false,
}).length;

function wrapWebFetchContent(value: string, maxChars: number): WebFetchWrappedContent {
  if (maxChars <= 0) {
    return { text: "", truncated: true, rawLength: value.length, length: 0 };
  }
  // Keep framing from outweighing source content in truncated previews. Short
  // sources can still retain the warning when both fit in full.
  const includeWarning =
    maxChars >=
    WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD +
      Math.min(value.length, WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD);
  const wrapperOverhead = includeWarning
    ? WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD
    : WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD;
  const maxInner = Math.max(0, maxChars - wrapperOverhead);
  // Charge sanitizer expansion before wrapping; clipping a later marker can
  // increase output size, so a second raw-length adjustment is not sufficient.
  const truncated = truncateSanitizedExternalContent(value, maxInner);
  // Tiny budgets may be shorter than the boundary markers themselves.
  const wrapped = truncateWebFetchText(
    wrapExternalContent(truncated.text, { source: "web_fetch", includeWarning }),
    maxChars,
  );

  return {
    text: wrapped.text,
    truncated: truncated.truncated || wrapped.truncated,
    rawLength: value.length,
    length: wrapped.text.length,
  };
}

type WebFetchWrappedContent = {
  text: string;
  truncated: boolean;
  rawLength: number;
  length: number;
  spill?: { path: string; chars: number; truncated?: true };
};

async function spillWebFetchContent(
  value: string,
  wrapped: WebFetchWrappedContent,
  maxChars: number,
  sourceTruncated: boolean,
  output: PrivateTempFileOptions,
): Promise<WebFetchWrappedContent> {
  if (!wrapped.truncated) {
    return sourceTruncated ? { ...wrapped, truncated: true } : wrapped;
  }
  // maxChars/maxCharsCap bound the model-visible return text. Recoverable spill
  // uses this fixed file cap so vanished pages can still be read after truncation.
  const content = truncateUtf16Safe(value, WEB_FETCH_SPILL_MAX_CHARS);
  const spillChars = content.length;
  let spillPath: string;
  output.assertCurrent?.();
  try {
    spillPath = await writePrivateTempFile(
      "openclaw-web-fetch",
      wrapWebContent(content, "web_fetch"),
      output,
    );
  } catch (error) {
    output.assertCurrent?.();
    if (!output.sandbox) {
      throw error;
    }
    const notice = "\n\n[Full output unavailable in sandbox.]";
    const visible = wrapWebFetchContent(value, maxChars - notice.length);
    const text = `${visible.text}${notice}`;
    return { ...visible, truncated: true, text, length: text.length };
  }
  const spillCapped = value.length > WEB_FETCH_SPILL_MAX_CHARS;
  const isSpillTruncated = sourceTruncated || spillCapped;
  const spillNote = sourceTruncated
    ? " Spilled available content from truncated response."
    : spillCapped
      ? ` Spilled first ${spillChars} chars.`
      : "";
  const fullOutputFooter = formatFullOutputFooter(spillPath);
  const footer = `\n\n[Showing truncated web_fetch content. ${fullOutputFooter}.${spillNote}]`;
  const compactFooter = `[${fullOutputFooter}]`;
  let visible = wrapped;
  let text = wrapped.text;
  if (footer.length <= maxChars) {
    visible = wrapWebFetchContent(value, maxChars - footer.length);
    text = `${visible.text}${footer}`;
  } else if (compactFooter.length <= maxChars) {
    visible = { ...wrapped, text: "", length: 0 };
    text = compactFooter;
  }
  return {
    ...visible,
    truncated: true,
    text,
    length: text.length,
    spill: {
      path: spillPath,
      chars: spillChars,
      ...(isSpillTruncated ? { truncated: true } : {}),
    },
  };
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

type WebFetchRuntimeParams = {
  url: string;
  toolCallId: string;
  transport?: WebFetchTransport;
  extractMode: ExtractMode;
  maxChars: number;
  maxResponseBytes: number;
  maxRedirects: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
  headers?: Record<string, string>;
  readabilityEnabled: boolean;
  config?: OpenClawConfig;
  useTrustedEnvProxy: boolean;
  ssrfPolicy?: SsrFPolicy;
  providerCacheKey?: string;
  lookupFn?: LookupFn;
  signal?: AbortSignal;
  resolveProviderFallback: () => Promise<WebFetchProviderFallback>;
  output: PrivateTempFileOptions;
  cacheScope?: string;
};

function normalizeProviderFinalUrl(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || containsAsciiControlCharacter(trimmed) || trimmed.includes(" ")) {
    return undefined;
  }
  const url = URL.parse(trimmed);
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? url.toString()
    : undefined;
}

export function throwIfFetchAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  // Async fetch, provider, and payload work can finish after an abort. Recheck
  // before wrapping, caching, or returning content from a canceled tool call.
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

// Repair model-injected scheme/authority whitespace; preserve path/query whitespace

async function buildWebFetchPayload(params: {
  providerId?: string;
  payload: unknown;
  requestedUrl: string;
  extractMode: ExtractMode;
  maxChars: number;
  tookMs: number;
  output: PrivateTempFileOptions;
}): Promise<Record<string, unknown>> {
  const payload = isRecord(params.payload) ? params.payload : {};
  let metadataTruncated = false;
  const boundProtocolField = (value: string, limit: number): string => {
    const bounded = truncateWebFetchText(value, limit);
    metadataTruncated ||= bounded.truncated;
    // The cache outlives the provider payload. Even an in-budget value can be a
    // slice of a discarded response; copy its UTF-16 units, including lone surrogates.
    return Buffer.from(bounded.text, "utf16le").toString("utf16le");
  };
  let remainingMetadataChars = Math.min(
    WEB_FETCH_METADATA_MAX_CHARS,
    Math.floor(params.maxChars / 2),
  );
  const wrapMetadata = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value) {
      return undefined;
    }
    const maxInner = Math.max(0, remainingMetadataChars - WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD);
    const bounded = truncateSanitizedExternalContent(
      value,
      Math.min(WEB_FETCH_FIELD_MAX_CHARS, maxInner),
    );
    metadataTruncated ||= bounded.truncated;
    if (!bounded.text) {
      return undefined;
    }
    const wrapped = wrapExternalContent(bounded.text, {
      source: "web_fetch",
      includeWarning: false,
    });
    remainingMetadataChars -= wrapped.length;
    return wrapped;
  };
  // Preserve the incomplete-response warning before spending the allowance on a title.
  const warning = wrapMetadata(payload.warning);
  const title = wrapMetadata(payload.title);
  const bodyMaxChars = params.maxChars - (title?.length ?? 0) - (warning?.length ?? 0);
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const wrapped = await spillWebFetchContent(
    rawText,
    wrapWebFetchContent(rawText, bodyMaxChars),
    bodyMaxChars,
    payload.truncated === true,
    params.output,
  );
  const providerRawLength =
    resolveOptionalIntegerOption(payload.rawLength, { min: 0 }) ?? wrapped.rawLength;
  const url = params.requestedUrl;
  const resolvedFinalUrl = normalizeProviderFinalUrl(payload.finalUrl) ?? url;
  const oversizedFinalUrl =
    resolvedFinalUrl !== url && resolvedFinalUrl.length > WEB_FETCH_RESULT_URL_MAX_CHARS;
  // As with invalid provider URLs, retain the requested URL rather than invent
  // a different destination by clipping a redirect's path or query.
  const finalUrl = oversizedFinalUrl ? url : resolvedFinalUrl;
  metadataTruncated ||= oversizedFinalUrl;
  const status = resolveIntegerOption(payload.status, 200, { min: 0 });
  const contentType =
    typeof payload.contentType === "string" ? normalizeContentType(payload.contentType) : undefined;
  const extractor =
    typeof payload.extractor === "string" && payload.extractor.trim()
      ? payload.extractor
      : (params.providerId ?? "raw");
  // These protocol fields are not prose and stay unwrapped, but provider or
  // response-controlled strings must not bypass the display-content budget.
  const boundedContentType = contentType ? boundProtocolField(contentType, 256) : undefined;
  const boundedExtractor = boundProtocolField(extractor, 128);
  const fetchedAt = boundProtocolField(
    typeof payload.fetchedAt === "string" && payload.fetchedAt
      ? payload.fetchedAt
      : new Date().toISOString(),
    64,
  );

  return {
    url,
    finalUrl,
    ...(boundedContentType ? { contentType: boundedContentType } : {}),
    status,
    ...(title ? { title } : {}),
    extractMode: params.extractMode,
    extractor: boundedExtractor,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
      ...(params.providerId ? { provider: params.providerId } : {}),
    },
    truncated: wrapped.truncated || metadataTruncated,
    length: wrapped.length,
    rawLength: providerRawLength,
    ...(wrapped.spill ? { spill: wrapped.spill } : {}),
    fetchedAt,
    tookMs: resolveOptionalIntegerOption(payload.tookMs, { min: 0 }) ?? params.tookMs,
    text: wrapped.text,
    ...(warning ? { warning } : {}),
  };
}

export async function runWebFetch(params: WebFetchRuntimeParams): Promise<Record<string, unknown>> {
  throwIfFetchAborted(params.signal);
  params.transport?.assertInvocationCurrent();
  const parsedUrl = URL.parse(params.url);
  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }
  // Routing headers partition the process-wide cache without retaining their secrets.
  const headersCacheKey = params.headers
    ? sha256Hex(JSON.stringify(Object.entries(params.headers)))
    : undefined;
  // Append the operator header set after the existing cache discriminators so
  // requests without custom headers keep their current cache key.
  const cacheDiscriminators = [
    params.cacheScope ? `sandbox:${params.cacheScope}` : "",
    `user-agent:${sha256Hex(params.userAgent)}`,
    params.providerCacheKey ? `provider:${params.providerCacheKey}` : "",
    params.ssrfPolicy ? `ssrf-policy:${sha256Hex(JSON.stringify(params.ssrfPolicy))}` : "",
    !params.transport && params.useTrustedEnvProxy ? "trusted-env-proxy" : "",
    headersCacheKey ? `headers:${headersCacheKey}` : "",
    params.transport
      ? `limits:${params.maxResponseBytes}:${params.maxRedirects}:${params.timeoutSeconds}:readability:${params.readabilityEnabled}`
      : "",
  ].filter(Boolean);
  const cacheKey = normalizeCacheKey(
    [
      `fetch:${parsedUrl.href}:${params.extractMode}:${params.maxChars}`,
      ...cacheDiscriminators,
    ].join(":"),
  );
  let cache = FETCH_CACHE;
  if (params.transport) {
    const scope = params.transport.cacheScope ?? params.transport;
    cache = HOST_FETCH_CACHES.get(scope) ?? new Map();
    HOST_FETCH_CACHES.set(scope, cache);
  }
  const cached = readCache(cache, cacheKey, params.cacheTtlMs);
  if (cached) {
    const spill = cached.value.spill;
    const sandbox = params.output.sandbox;
    const available =
      !sandbox ||
      !isRecord(spill) ||
      typeof spill.path !== "string" ||
      (
        await sandbox.bridge?.stat({
          filePath: spill.path,
          cwd: sandbox.root,
          expectedPolicyPath: spill.path,
          signal: params.signal,
        })
      )?.type === "file";
    params.output.assertCurrent?.();
    params.transport?.assertInvocationCurrent();
    if (available) {
      return { ...cached.value, cached: true };
    }
  }

  // Preserve the direct fetch's rejection; replacing it with signal.reason would
  // discard the transport's own error detail.
  const payload = await fetchWebPayload(
    params.transport ? { ...params, url: parsedUrl.href } : params,
  );
  // Publish only after guard release: cancellation or cleanup failure must not
  // leave a successful cache entry for a call that never returned its content.
  throwIfFetchAborted(params.signal);
  params.transport?.assertInvocationCurrent();
  params.output.assertCurrent?.();
  if (!params.output.sandbox || !payload.truncated || payload.spill) {
    writeCache(cache, cacheKey, payload, params.cacheTtlMs);
  }
  return payload;
}

async function fetchWebPayload(params: WebFetchRuntimeParams): Promise<Record<string, unknown>> {
  const start = Date.now();
  async function fetchProviderPayload(urlToFetch: string): Promise<Record<string, unknown> | null> {
    if (params.transport) {
      return null;
    }
    const tookMs = Date.now() - start;
    const providerFallback = await params.resolveProviderFallback();
    throwIfFetchAborted(params.signal);
    if (!providerFallback) {
      return null;
    }
    let rawPayload: unknown;
    try {
      rawPayload = await providerFallback.definition.execute(
        { url: urlToFetch, extractMode: params.extractMode, maxChars: params.maxChars },
        { signal: params.signal },
      );
    } catch (error) {
      // Cancellation wins over a provider failure arriving after the caller abandoned it.
      throwIfFetchAborted(params.signal);
      throw error;
    }
    throwIfFetchAborted(params.signal);
    return await buildWebFetchPayload({
      providerId: providerFallback.provider.id,
      payload: rawPayload,
      requestedUrl: params.url,
      extractMode: params.extractMode,
      maxChars: params.maxChars,
      tookMs,
      output: params.output,
    });
  }

  let res: Response;
  let release: () => Promise<void>;
  let finalUrl = params.url;
  try {
    const request = {
      url: params.url,
      maxRedirects: params.maxRedirects,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        // Preserve casing and order on the wire; operator headers are already collision-free.
        headers: {
          Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
          "User-Agent": params.userAgent,
          "Accept-Language": "en-US,en;q=0.9",
          ...params.headers,
        },
      },
    };
    const result = params.transport
      ? await params.transport.acquire({
          ...request,
          toolCallId: params.toolCallId,
          init: { ...request.init, method: "GET" },
          maxResponseBytes: params.maxResponseBytes,
          ssrfPolicy: params.ssrfPolicy,
        })
      : await (
          await loadWebGuardedFetch()
        ).fetchWithWebToolsNetworkGuard({
          ...request,
          lookupFn: params.lookupFn,
          useEnvProxy: params.useTrustedEnvProxy,
          policy: params.ssrfPolicy,
          capture: params.headers
            ? { sensitiveRequestHeaderNames: Object.keys(params.headers) }
            : undefined,
        });
    res = result.response;
    finalUrl = result.finalUrl;
    release = result.release;

    const markdownTokens = res.headers.get("x-markdown-tokens");
    if (markdownTokens) {
      logDebug(
        `[web-fetch] x-markdown-tokens: ${markdownTokens} (${redactUrlForDebugLog(finalUrl)})`,
      );
    }
  } catch (error) {
    if (params.transport || error instanceof SsrFBlockedError || params.signal?.aborted) {
      throw error;
    }
    const payload = await fetchProviderPayload(finalUrl);
    if (payload) {
      return payload;
    }
    throw error;
  }

  try {
    if (params.transport) {
      throwIfFetchAborted(params.signal);
      params.transport.assertInvocationCurrent();
      const normalizedFinalUrl = normalizeProviderFinalUrl(finalUrl);
      if (!normalizedFinalUrl) {
        throw new Error("web_fetch transport returned an invalid final HTTP(S) URL.");
      }
      finalUrl = normalizedFinalUrl;
    }
    if (!res.ok) {
      throwIfFetchAborted(params.signal);
      const payload = await fetchProviderPayload(params.url);
      if (payload) {
        return payload;
      }
      const rawDetailResult = await readResponseText(res, {
        maxBytes: params.transport
          ? Math.min(DEFAULT_ERROR_MAX_BYTES, params.maxResponseBytes)
          : DEFAULT_ERROR_MAX_BYTES,
      });
      throwIfFetchAborted(params.signal);
      params.transport?.assertInvocationCurrent();
      const detail = formatWebFetchErrorDetail({
        detail: rawDetailResult.text,
        contentType: res.headers.get("content-type"),
      });
      const wrappedDetail = wrapWebFetchContent(detail || res.statusText, DEFAULT_ERROR_MAX_CHARS);
      throw new Error(`Web fetch failed (${res.status}): ${wrappedDetail.text}`);
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const normalizedContentType = normalizeContentType(contentType) ?? "application/octet-stream";
    const bodyResult = await readResponseText(res, { maxBytes: params.maxResponseBytes });
    throwIfFetchAborted(params.signal);
    params.transport?.assertInvocationCurrent();
    const body = bodyResult.text;
    const responseTruncatedWarning = bodyResult.truncated
      ? `Response body incomplete after ${bodyResult.bytesRead} bytes.`
      : undefined;

    let title: string | undefined;
    let extractor = "raw";
    let text = body;
    if (normalizedContentType === "text/markdown") {
      extractor = "cf-markdown";
      if (params.extractMode === "text") {
        text = markdownToText(body);
      }
    } else if (["text/html", "application/xhtml+xml"].includes(normalizedContentType)) {
      if (!params.readabilityEnabled) {
        const payload = await fetchProviderPayload(finalUrl);
        if (payload) {
          return payload;
        }
        throw new Error(
          params.transport
            ? "Web fetch extraction failed: Readability is disabled for host-acquired HTML."
            : "Web fetch extraction failed: Readability disabled and no fetch provider is available.",
        );
      }
      let extracted = await extractReadableContent({
        html: body,
        url: finalUrl,
        extractMode: params.extractMode,
        config: params.config,
      });
      if (!extracted?.text) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = await fetchProviderPayload(finalUrl);
        } catch {
          throwIfFetchAborted(params.signal);
        }
        if (payload) {
          return payload;
        }
        const basic = await extractBasicHtmlContent({
          html: body,
          extractMode: params.extractMode,
        });
        if (!basic?.text) {
          const providerLabel = params.transport
            ? undefined
            : ((await params.resolveProviderFallback())?.provider.label ?? "provider fallback");
          throw new Error(
            params.transport
              ? "Web fetch extraction failed: Readability and basic HTML cleanup returned no content."
              : `Web fetch extraction failed: Readability, ${providerLabel}, and basic HTML cleanup returned no content.`,
          );
        }
        extracted = { ...basic, extractor: "raw-html" };
      }
      ({ text, title, extractor } = extracted);
    } else if (
      normalizedContentType === "application/json" ||
      normalizedContentType.endsWith("+json")
    ) {
      // Structured +json subtypes are single JSON documents; sequence formats are not.
      try {
        // Keep pretty-printing without rounding or normalizing numeric source tokens.
        // Numeric reviver calls always include source context on supported runtimes.
        text = JSON.stringify(
          JSON.parse(body, (_key, value: unknown, context?: { source: string }) =>
            typeof value === "number" ? JSON.rawJSON(context!.source) : value,
          ),
          null,
          2,
        );
        extractor = "json";
      } catch {
        text = body;
        extractor = "raw";
      }
    }

    return await buildWebFetchPayload({
      payload: {
        finalUrl,
        status: res.status,
        contentType: normalizedContentType,
        title,
        extractor,
        text,
        warning: responseTruncatedWarning,
        truncated: bodyResult.truncated,
      },
      requestedUrl: params.url,
      extractMode: params.extractMode,
      maxChars: params.maxChars,
      tookMs: Date.now() - start,
      output: params.transport
        ? {
            ...params.output,
            assertCurrent: () => {
              params.output.assertCurrent?.();
              throwIfFetchAborted(params.signal);
              params.transport?.assertInvocationCurrent();
            },
          }
        : params.output,
    });
  } finally {
    if (!res.bodyUsed) {
      // Fallbacks and provider failures can abandon the upstream stream. Cancel
      // without awaiting so a stalled cancellation cannot block guard release.
      void res.body?.cancel().catch(() => undefined);
    }
    await release();
    if (params.transport) {
      throwIfFetchAborted(params.signal);
      params.transport.assertInvocationCurrent();
    }
  }
}
