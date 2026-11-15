import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import type { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import type { ThinkingCatalogEntry } from "../auto-reply/thinking.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionTranscriptUsageSnapshot } from "../gateway/session-transcript-derived-readers.js";
import { formatTokenCount } from "../utils/usage-format.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";

export type StatusMessageUsageArgs = {
  config: OpenClawConfig;
  modelRefs: ReturnType<typeof resolveSelectedAndActiveModel>;
  sessionEntry?: SessionEntry;
  activeModel?: { modelProvider: string; model: string };
  thinkingCatalog?: ThinkingCatalogEntry[];
  transcriptUsage?: SessionTranscriptUsageSnapshot | null;
};

export const formatTokensPairValue = (input?: number | null, output?: number | null) => {
  if (input == null && output == null) {
    return null;
  }
  const inputLabel = input == null ? "?" : formatTokenCount(input);
  const outputLabel = output == null ? "?" : formatTokenCount(output);
  return `${inputLabel} in / ${outputLabel} out`;
};

export const formatCacheHitValue = (
  input?: number | null,
  cacheRead?: number | null,
  cacheWrite?: number | null,
) => {
  if ((cacheRead == null || cacheRead < 0) && (cacheWrite == null || cacheWrite < 0)) {
    return null;
  }

  const cachedLabel = formatTokenCount(cacheRead ?? 0);
  const newLabel = formatTokenCount(cacheWrite ?? 0);

  const totalInput = (cacheRead ?? 0) + (cacheWrite ?? 0) + (input ?? 0);
  const hitRate = totalInput > 0 ? Math.round(((cacheRead ?? 0) / totalInput) * 100) : 0;

  return `${hitRate}% hit · ${cachedLabel} cached, ${newLabel} new`;
};

const formatTranscriptUsage = (snapshot: SessionTranscriptUsageSnapshot) => {
  const input = snapshot.inputTokens ?? 0;
  const output = snapshot.outputTokens ?? 0;
  const cacheRead = snapshot.cacheRead;
  const cacheWrite = snapshot.cacheWrite;
  const promptTokens = snapshot.totalTokens ?? input + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const total = promptTokens + output;
  if (promptTokens === 0 && total === 0 && !snapshot.usageReport) {
    return undefined;
  }
  const model = snapshot.modelProvider
    ? snapshot.model
      ? `${snapshot.modelProvider}/${snapshot.model}`
      : snapshot.modelProvider
    : snapshot.model;

  return {
    usageReport: snapshot.usageReport,
    input,
    output,
    cacheRead,
    cacheWrite,
    promptTokens,
    total,
    totalTokensFresh: snapshot.totalTokensFresh === true,
    model,
  };
};

export function resolveStatusMessageUsage(args: StatusMessageUsageArgs) {
  const entry = args.sessionEntry;
  const { modelRefs } = args;
  const selectedLookupProvider = modelRefs.selected.provider;
  const selectedLookupModel = modelRefs.selected.model;
  const initialFallbackState = resolveActiveFallbackState({
    selectedModelRef: modelRefs.selected.label || "unknown",
    activeModelRef: modelRefs.active.label || "unknown",
    config: args.config,
    state: entry,
  });
  let activeProvider = modelRefs.active.provider;
  let activeModel = modelRefs.active.model;
  let contextLookupProvider: string | undefined = activeProvider;
  let contextLookupModel = activeModel;
  const runtimeModelRaw = normalizeOptionalString(args.activeModel?.model ?? entry?.model) ?? "";
  const runtimeProviderRaw =
    normalizeOptionalString(args.activeModel?.modelProvider ?? entry?.modelProvider) ?? "";

  if (runtimeModelRaw && !runtimeProviderRaw && runtimeModelRaw.includes("/")) {
    const slashIndex = runtimeModelRaw.indexOf("/");
    const embeddedProvider =
      normalizeOptionalLowercaseString(runtimeModelRaw.slice(0, slashIndex)) ?? "";
    const fallbackMatchesRuntimeModel =
      initialFallbackState.active &&
      normalizeLowercaseStringOrEmpty(runtimeModelRaw) ===
        normalizeLowercaseStringOrEmpty(entry?.fallbackNotice?.activeModel);
    const runtimeMatchesSelectedModel =
      normalizeLowercaseStringOrEmpty(runtimeModelRaw) ===
      normalizeLowercaseStringOrEmpty(modelRefs.selected.label || "unknown");
    // A slash can be part of a provider-local model ID. Prefer its current
    // catalog identity before interpreting a legacy provider-qualified ID.
    if (findModelInCatalog(args.thinkingCatalog ?? [], activeProvider, runtimeModelRaw)) {
      contextLookupModel = runtimeModelRaw;
    } else if (
      (!fallbackMatchesRuntimeModel && !runtimeMatchesSelectedModel) ||
      embeddedProvider !== normalizeLowercaseStringOrEmpty(activeProvider)
    ) {
      contextLookupProvider = undefined;
      contextLookupModel = runtimeModelRaw;
    }
  }

  let inputTokens = entry?.inputTokens;
  let outputTokens = entry?.outputTokens;
  let cacheRead = entry?.cacheRead;
  let cacheWrite = entry?.cacheWrite;
  let usageReport = entry?.usageReport;
  const freshTotalTokens = resolveFreshSessionTotalTokens(entry);
  const allowTranscriptContextUsage =
    entry?.totalTokensFresh !== false && freshTotalTokens === undefined;
  let totalTokens = freshTotalTokens;

  // Explicitly stale session/cache usage can still hydrate Tokens/Cache lines
  // but must not become Context.
  if (args.transcriptUsage) {
    const logUsage = formatTranscriptUsage(args.transcriptUsage);
    if (logUsage) {
      usageReport ??= logUsage.usageReport;
      const candidate =
        logUsage.totalTokensFresh && logUsage.usageReport?.state !== "unavailable"
          ? logUsage.promptTokens || logUsage.total
          : undefined;
      if (
        allowTranscriptContextUsage &&
        candidate !== undefined &&
        candidate >= 0 &&
        (!totalTokens || candidate > totalTokens)
      ) {
        totalTokens = candidate;
      }
      if (!entry?.model && !args.activeModel && logUsage.model) {
        const slashIndex = logUsage.model.indexOf("/");
        if (
          slashIndex > 0 &&
          !findModelInCatalog(args.thinkingCatalog ?? [], activeProvider, logUsage.model)
        ) {
          const provider = logUsage.model.slice(0, slashIndex).trim();
          const model = logUsage.model.slice(slashIndex + 1).trim();
          if (provider && model) {
            const catalogEntry = findModelInCatalog(args.thinkingCatalog ?? [], provider, model);
            activeProvider = provider;
            activeModel = model;
            // Bind exact catalog identities; keep cross-route namespaced ids raw.
            contextLookupProvider = catalogEntry ? provider : undefined;
            contextLookupModel = catalogEntry ? model : logUsage.model;
          }
        } else {
          activeModel = logUsage.model;
          // Bare IDs and catalog-owned slash IDs retain the known provider.
          contextLookupProvider = activeProvider;
          contextLookupModel = logUsage.model;
        }
      }
      if (entry?.usageReport?.state !== "available") {
        if (!inputTokens) {
          inputTokens = logUsage.input;
        }
        if (!outputTokens) {
          outputTokens = logUsage.output;
        }
        if (cacheRead === undefined || cacheRead <= 0) {
          cacheRead = logUsage.cacheRead ?? cacheRead;
        }
        if (cacheWrite === undefined || cacheWrite <= 0) {
          cacheWrite = logUsage.cacheWrite ?? cacheWrite;
        }
      }
    }
  }

  if (usageReport?.state === "unavailable") {
    inputTokens = outputTokens = cacheRead = cacheWrite = undefined;
  }

  return {
    selectedLookupProvider,
    selectedLookupModel,
    initialFallbackState,
    activeProvider,
    activeModel,
    contextLookupProvider,
    contextLookupModel,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    usageReport,
    totalTokens,
    estimatedCostUsd:
      usageReport?.state === "unavailable"
        ? undefined
        : asNonNegativeFiniteNumber(entry?.estimatedCostUsd),
  };
}
