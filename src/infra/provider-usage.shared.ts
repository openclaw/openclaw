import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import bundledProviderNames from "../shared/provider-names.generated.json" with { type: "json" };
import type { UsageProviderId } from "./provider-usage.types.js";

/** One provider cannot hold the aggregate usage response beyond this deadline. */
export const PROVIDER_USAGE_TIMEOUT_MS = 5000;

// Preserve the shipped SDK's closed-key export, deriving every value from the manifest owner.
export const PROVIDER_LABELS = {
  anthropic: bundledProviderNames.anthropic,
  clawrouter: bundledProviderNames.clawrouter,
  deepseek: bundledProviderNames.deepseek,
  "github-copilot": bundledProviderNames["github-copilot"],
  "google-gemini-cli": bundledProviderNames["google-gemini-cli"],
  minimax: bundledProviderNames.minimax,
  openai: bundledProviderNames.openai,
  openrouter: bundledProviderNames.openrouter,
  venice: bundledProviderNames.venice,
  xai: bundledProviderNames.xai,
  xiaomi: bundledProviderNames.xiaomi,
  "xiaomi-token-plan": bundledProviderNames["xiaomi-token-plan"],
  zai: bundledProviderNames.zai,
} as const satisfies Readonly<Record<string, string>>;

/** Dynamic-key lookup view; closed-key reads should use PROVIDER_LABELS directly. */
export function providerUsageLabel(provider: string): string | undefined {
  const labels: Readonly<Record<string, string | undefined>> = PROVIDER_LABELS;
  return labels[provider];
}

/** Returns true for providers whose usage endpoint is only meaningful with OAuth/token auth. */
export function isOAuthOnlyUsageProvider(provider: UsageProviderId): boolean {
  return provider === "openai";
}

/** Maps model/provider ids and credential type into a normalized usage provider id. */
export function resolveUsageProviderId(
  provider?: string | null,
  options?: { credentialType?: string | null },
): UsageProviderId | undefined {
  if (!provider) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  if (normalized === "openai") {
    return options?.credentialType === "oauth" || options?.credentialType === "token"
      ? normalized
      : undefined;
  }
  // Claude CLI-backed models bill against the same Anthropic subscription as
  // native anthropic OAuth; without this mapping claude-cli-only setups get
  // "Unsupported provider" instead of plan usage windows.
  if (normalized === "claude-cli") {
    return "anthropic";
  }
  if (
    normalized === "minimax-portal" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal-cn"
  ) {
    return "minimax";
  }
  return normalized || undefined;
}

export const ignoredErrors = new Set([
  "No credentials",
  "No token",
  "No API key",
  "Not logged in",
  "No auth",
]);

export const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

/** Aborts usage collection and returns a fallback when its deadline expires. */
export const raceUsageTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const timeoutMs = resolveTimerTimeoutMs(ms, 1);
  try {
    return await Promise.race([
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          resolve(fallback);
          controller.abort(new DOMException("Usage collection timed out", "TimeoutError"));
        }, timeoutMs);
      }),
      work(controller.signal),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
