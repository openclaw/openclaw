import { randomUUID } from "node:crypto";
import {
  asPositiveFiniteNumber,
  resolveIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type { LookupFn } from "../../infra/net/ssrf.js";
import { logWarn } from "../../logger.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { runtimeWebSecretOwnerId } from "../../secrets/runtime-web-secret-owner.js";
import type { RuntimeWebFetchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { isRecord } from "../../utils.js";
import { resolveWebProviderConfig } from "../../web/provider-runtime-shared.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.types.js";
import { stringEnum } from "../schema/string-enum.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  scheduleToolProgress,
} from "./common.js";
import { runWebFetch, throwIfFetchAborted } from "./web-fetch-runtime.js";
import type { WebFetchTransport } from "./web-fetch-transport.js";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
} from "./web-shared.js";
import { resolveWebToolRuntimeContext } from "./web-tool-runtime-context.js";

const EXTRACT_MODES = ["markdown", "text"] as const;

const DEFAULT_FETCH_MAX_CHARS = 20_000;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 750_000;
const FETCH_MAX_RESPONSE_BYTES_MIN = 32_000;
const FETCH_MAX_RESPONSE_BYTES_MAX = 10_000_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const WEB_FETCH_PROGRESS_THRESHOLD_MS = 5_000;
const WEB_FETCH_PROGRESS_TEXT = "Fetching page content...";
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Accept and Accept-Language are part of the fetch/readability contract,
// User-Agent has its own tools.web.fetch.userAgent key, and Undici owns
// Sec-Fetch-Mode.
const FETCH_BLOCKED_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "user-agent",
  "sec-fetch-mode",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP(S) URL." }),
  extractMode: Type.Optional(
    stringEnum(EXTRACT_MODES, {
      description: "Extract as markdown/text.",
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      description: "Max chars returned; truncates.",
      minimum: 100,
    }),
  ),
});

const WebFetchOutputSchema = Type.Object(
  {
    url: Type.String(),
    finalUrl: Type.String(),
    status: Type.Integer({ minimum: 0 }),
    contentType: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    extractMode: stringEnum(EXTRACT_MODES),
    extractor: Type.String(),
    externalContent: Type.Object(
      {
        untrusted: Type.Literal(true),
        source: Type.Literal("web_fetch"),
        wrapped: Type.Literal(true),
        provider: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    truncated: Type.Boolean(),
    length: Type.Integer({ minimum: 0 }),
    rawLength: Type.Integer({ minimum: 0 }),
    spill: Type.Optional(
      Type.Object(
        {
          path: Type.String(),
          chars: Type.Integer({ minimum: 0 }),
          truncated: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ),
    fetchedAt: Type.String(),
    tookMs: Type.Integer({ minimum: 0 }),
    text: Type.String(),
    warning: Type.Optional(Type.String()),
    cached: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

type WebFetchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["fetch"];
const loadWebFetchRuntime = createLazyPromise(() => import("../../web-fetch/runtime.js"));

function resolveFetchConfig(cfg?: OpenClawConfig): WebFetchConfig {
  return resolveWebProviderConfig(cfg, "fetch") as NonNullable<WebFetchConfig> | undefined;
}

/**
 * Operator headers web_fetch may actually send. Every dropped entry gets its own
 * warning: a silently ignored routing header looks exactly like working egress.
 * Header names are safe to log; values are not.
 */
function resolveFetchHeaders(fetch?: WebFetchConfig): Record<string, string> | undefined {
  const configured = fetch?.headers;
  if (!configured) {
    return undefined;
  }
  const resolved = new Map<string, { name: string; value: string }>();
  for (const [rawName, rawValue] of Object.entries(configured)) {
    const name = rawName.trim();
    const lowerName = name.toLowerCase();
    const prior = resolved.get(lowerName);
    if (prior) {
      resolved.delete(lowerName);
      logWarn(
        `[web-fetch] dropped case-colliding tools.web.fetch.headers entry: ${JSON.stringify(prior.name)}`,
      );
    }
    let value: string;
    try {
      value = new Headers([[name, rawValue]]).get(name) ?? "";
    } catch {
      logWarn(
        `[web-fetch] dropped tools.web.fetch.headers entry a request cannot carry: ${JSON.stringify(rawName)}`,
      );
      continue;
    }
    if (FETCH_BLOCKED_HEADER_NAMES.has(lowerName)) {
      logWarn(`[web-fetch] dropped reserved or framing tools.web.fetch.headers entry: ${name}`);
      continue;
    }
    resolved.set(lowerName, { name, value });
  }
  const entries = [...resolved.values()]
    .map(({ name, value }) => [name, value] as const)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatTerminalWebFetchOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return URL.parse(value)?.origin;
}

function formatWebFetchTerminalPresentation(result: unknown): { text: string } | undefined {
  if (!isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  const details = result.details;
  const origin =
    formatTerminalWebFetchOrigin(details.finalUrl) ?? formatTerminalWebFetchOrigin(details.url);
  const status = typeof details.status === "number" ? details.status : undefined;
  if (!origin || status === undefined) {
    return undefined;
  }
  const lines = [`Web fetch completed.`, `Origin: ${origin}`, `Status: ${status}`];
  if (typeof details.contentType === "string" && details.contentType.trim()) {
    lines.push(`Content type: ${details.contentType.trim()}`);
  }
  if (typeof details.rawLength === "number" && Number.isFinite(details.rawLength)) {
    lines.push(`Content length: ${Math.max(0, Math.floor(details.rawLength))} characters`);
  }
  if (details.truncated === true) {
    lines.push("Truncated: yes");
  }
  return { text: lines.join("\n") };
}

// for the URL parser to percent-encode.
function sanitizeWebFetchUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  const trimmed = raw.slice(0, end).replace(/^\s+/, "");
  const repaired = trimmed.replace(/^(https?:\/\/)\s+/i, "$1");
  return repaired.replace(/^(https?:\/\/[^/?#\s]+)\s+$/i, "$1");
}

export function createWebFetchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  agentSessionKey?: string;
  assertInvocationCurrent?: () => void;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  lateBindRuntimeConfig?: boolean;
  lookupFn?: LookupFn;
  hostnameAllowlistRef?: { value?: string[] };
  transport?: WebFetchTransport;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  if (fetch?.enabled === false) {
    return null;
  }
  // Saved locations belong to the requesting session and filesystem, even when
  // another caller fetches the same URL with identical network settings.
  const cacheScope = options?.sandboxed
    ? sha256Hex(JSON.stringify([options.agentSessionKey ?? randomUUID(), options.sandboxRoot]))
    : undefined;
  const tool: AnyAgentTool = {
    label: "Web Fetch",
    name: "web_fetch",
    resultContentSource: "network",
    description: "Fetch URL; extract readable markdown/text. Lightweight; no browser automation.",
    parameters: WebFetchSchema,
    outputSchema: WebFetchOutputSchema,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const assertSourceCurrent = captureAgentToolSourceExecutionGuard(signal);
      const assertCurrent = () => {
        assertSourceCurrent();
        options?.assertInvocationCurrent?.();
      };
      assertCurrent();
      const {
        config,
        preferRuntimeProviders,
        providerSelectionId,
        runtimeMetadata: runtimeWebFetch,
      } = resolveWebToolRuntimeContext({
        kind: "fetch",
        config: options?.config,
        lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
        runtimeMetadata: options?.runtimeWebFetch,
      });
      const executionFetch = resolveFetchConfig(config);
      if (executionFetch?.enabled === false) {
        throw new Error("web_fetch is disabled.");
      }
      if (providerSelectionId && !options?.transport) {
        assertSecretOwnerAvailable(
          "capability",
          runtimeWebSecretOwnerId("fetch", providerSelectionId),
        );
      }
      const providerCacheKey = options?.transport
        ? undefined
        : (normalizeOptionalLowercaseString(runtimeWebFetch?.selectedProvider) ??
          normalizeOptionalLowercaseString(runtimeWebFetch?.providerConfigured) ??
          normalizeOptionalLowercaseString(executionFetch?.provider));
      const readabilityEnabled = executionFetch?.readability !== false;
      const userAgent =
        (typeof executionFetch?.userAgent === "string" && executionFetch.userAgent) ||
        DEFAULT_FETCH_USER_AGENT;
      const maxResponseBytes = resolveIntegerOption(
        asPositiveFiniteNumber(executionFetch?.maxResponseBytes),
        DEFAULT_FETCH_MAX_RESPONSE_BYTES,
        { min: FETCH_MAX_RESPONSE_BYTES_MIN, max: FETCH_MAX_RESPONSE_BYTES_MAX },
      );
      const resolveProviderFallback = createLazyPromise(async () => {
        const { resolveWebFetchDefinition } = await loadWebFetchRuntime();
        return resolveWebFetchDefinition({
          config,
          sandboxed: options?.sandboxed,
          runtimeWebFetch,
          preferRuntimeProviders,
        });
      });
      const params = args as Record<string, unknown>;
      const url = sanitizeWebFetchUrl(
        readToolStringParam(params, "url", { required: true, trim: false }),
      );
      const extractMode =
        readToolStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readPositiveIntegerParam(params, "maxChars");
      const maxCharsCap = resolveIntegerOption(
        executionFetch?.maxCharsCap,
        DEFAULT_FETCH_MAX_CHARS,
        { min: 100 },
      );
      const hostnameAllowlist = options?.hostnameAllowlistRef?.value;
      // The progress line is emitted only if the fetch is still pending after
      // the threshold; fast cache/network hits clear the timer before it fires.
      const clearProgressTimer = scheduleToolProgress(
        onUpdate,
        { text: WEB_FETCH_PROGRESS_TEXT, id: "web_fetch:fetching" },
        WEB_FETCH_PROGRESS_THRESHOLD_MS,
        { signal },
      );
      try {
        const result = await runWebFetch({
          url,
          toolCallId,
          transport: options?.transport,
          extractMode,
          maxChars: resolveIntegerOption(
            maxChars ?? executionFetch?.maxChars,
            DEFAULT_FETCH_MAX_CHARS,
            { min: 100, max: maxCharsCap },
          ),
          maxResponseBytes,
          maxRedirects: resolveIntegerOption(
            executionFetch?.maxRedirects,
            DEFAULT_FETCH_MAX_REDIRECTS,
            { min: 0 },
          ),
          timeoutSeconds: resolveTimeoutSeconds(
            executionFetch?.timeoutSeconds,
            DEFAULT_TIMEOUT_SECONDS,
          ),
          cacheTtlMs: resolveCacheTtlMs(executionFetch?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
          userAgent,
          headers: resolveFetchHeaders(executionFetch),
          readabilityEnabled,
          config,
          useTrustedEnvProxy: executionFetch?.useTrustedEnvProxy === true,
          ssrfPolicy: hostnameAllowlist
            ? { ...executionFetch?.ssrfPolicy, hostnameAllowlist }
            : executionFetch?.ssrfPolicy,
          ...(providerCacheKey ? { providerCacheKey } : {}),
          lookupFn: options?.lookupFn,
          signal,
          resolveProviderFallback,
          cacheScope,
          output: {
            ...(options?.sandboxed
              ? { sandbox: { root: options.sandboxRoot, bridge: options.sandboxFsBridge } }
              : {}),
            assertCurrent,
            signal,
          },
        });
        if (options?.transport) {
          throwIfFetchAborted(signal);
          options.transport.assertInvocationCurrent();
        }
        return jsonResult(result);
      } finally {
        clearProgressTimer();
      }
    },
  };
  return setToolTerminalPresentation(tool, (_params, result) =>
    formatWebFetchTerminalPresentation(result),
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
