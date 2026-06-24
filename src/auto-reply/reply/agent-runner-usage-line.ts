import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  type ModelCostConfig,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { resolveEffectiveResponseUsage } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { buildUsageContract } from "../usage-bar/contract.js";
import { loadUsageBarTemplate } from "../usage-bar/template.js";
import { renderUsageBar } from "../usage-bar/translator.js";

const REPLY_FOOTER_USAGE_TIMEOUT_MS = 2500;
const REPLY_FOOTER_OAUTH_ONLY_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai",
]);

function resolveReplyFooterUsageCredentialType(
  authLabel?: string,
): "oauth" | "token" | "api_key" | undefined {
  const auth = normalizeOptionalLowercaseString(authLabel);
  if (auth?.startsWith("oauth")) {
    return "oauth";
  }
  if (auth?.startsWith("token")) {
    return "token";
  }
  if (auth?.startsWith("api-key") || auth?.startsWith("api key")) {
    return "api_key";
  }
  return undefined;
}

async function loadReplyFooterUsageWindowLine(params: {
  provider?: string;
  authLabel?: string;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<string | undefined> {
  const credentialType = resolveReplyFooterUsageCredentialType(params.authLabel);
  const usageProvider = resolveUsageProviderId(params.provider, { credentialType });
  if (
    !usageProvider ||
    (REPLY_FOOTER_OAUTH_ONLY_PROVIDERS.has(usageProvider) &&
      credentialType !== "oauth" &&
      credentialType !== "token")
  ) {
    return undefined;
  }

  try {
    let usageTimeout: NodeJS.Timeout | undefined;
    const usageSummary = await Promise.race([
      loadProviderUsageSummary({
        timeoutMs: REPLY_FOOTER_USAGE_TIMEOUT_MS,
        providers: [usageProvider],
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        config: params.config,
      }),
      new Promise<never>((_, reject) => {
        usageTimeout = setTimeout(
          () => reject(new Error("reply footer usage timeout")),
          REPLY_FOOTER_USAGE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (usageTimeout) {
        clearTimeout(usageTimeout);
      }
    });
    const usageEntry = usageSummary.providers[0];
    if (
      !usageEntry ||
      usageEntry.error ||
      (usageEntry.windows.length === 0 && !usageEntry.summary?.trim())
    ) {
      return undefined;
    }
    return (
      formatUsageWindowSummary(usageEntry, {
        now: Date.now(),
        maxWindows: 2,
      }) ?? undefined
    );
  } catch {
    return undefined;
  }
}

export const formatResponseUsageLine = (params: {
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  showCost: boolean;
  costConfig?: ModelCostConfig;
}): string | null => {
  const usage = params.usage;
  if (!usage) {
    return null;
  }
  const input = usage.input;
  const output = usage.output;
  if (typeof input !== "number" && typeof output !== "number") {
    return null;
  }
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : undefined;
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined;
  const cost =
    params.showCost && typeof input === "number" && typeof output === "number"
      ? estimateUsageCost({
          usage: {
            input,
            output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          cost: params.costConfig,
        })
      : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  const cacheSuffix =
    (typeof cacheRead === "number" && cacheRead > 0) ||
    (typeof cacheWrite === "number" && cacheWrite > 0)
      ? ` · cache ${formatTokenCount(cacheRead ?? 0)} cached / ${formatTokenCount(cacheWrite ?? 0)} new`
      : "";
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${inputLabel} in / ${outputLabel} out${cacheSuffix}${suffix}`;
};

export const resolveResponseUsageLine = (params: {
  config: OpenClawConfig;
  sessionRaw?: string | null;
  channel?: string;
  usage?: NormalizedUsage;
  provider?: string;
  model?: string;
  preserveUserFacingSessionState?: boolean;
  replyUsageState?: PluginHookReplyUsageState;
  authMode?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<string | undefined> => {
  const responseUsageMode = resolveEffectiveResponseUsage(
    params.sessionRaw,
    params.config.messages?.responseUsage,
    params.channel,
  );
  if (
    responseUsageMode === "off" ||
    !hasNonzeroUsage(params.usage) ||
    params.preserveUserFacingSessionState === true
  ) {
    return undefined;
  }

  const costConfig = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.config,
    allowPluginNormalization: false,
  });
  const showCost = responseUsageMode === "full" && costConfig !== undefined;
  const formatted = formatResponseUsageLine({
    usage: params.usage,
    showCost,
    costConfig,
  });
  const usageTemplate =
    responseUsageMode === "full" && params.replyUsageState
      ? loadUsageBarTemplate(params.config.messages?.usageTemplate)
      : undefined;
  const rendered =
    usageTemplate && params.replyUsageState
      ? renderUsageBar(usageTemplate, buildUsageContract(params.replyUsageState, params.channel))
      : undefined;

  const line = rendered ?? formatted ?? undefined;
  if (!line) {
    return undefined;
  }

  const authLabel =
    params.authMode ??
    (params.config.models?.providers && params.provider && params.provider in params.config.models.providers
      ? (resolveModelAuthMode(params.provider, params.config, undefined, {
          workspaceDir: params.workspaceDir,
        }) ?? undefined)
      : undefined);
  const providerUsageLine = await loadReplyFooterUsageWindowLine({
    provider: params.provider,
    authLabel,
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  return providerUsageLine ? `${line} · ${providerUsageLine}` : line;
};

export const appendUsageLine = (payloads: ReplyPayload[], line: string): ReplyPayload[] => {
  let index = -1;
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    if (payloads[i]?.text) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return [...payloads, { text: line }];
  }
  const existing = payloads[index];
  const existingText = existing.text ?? "";
  const separator = existingText.endsWith("\n") ? "" : "\n";
  const next = {
    ...existing,
    text: `${existingText}${separator}${line}`,
  };
  const metadata = getReplyPayloadMetadata(existing);
  // Transcript mirrors must track the mutated text or source-reply delivery drifts.
  const nextWithMetadata = metadata
    ? setReplyPayloadMetadata(next, {
        ...metadata,
        ...(metadata.sourceReplyTranscriptMirror
          ? {
              sourceReplyTranscriptMirror: {
                ...metadata.sourceReplyTranscriptMirror,
                text: next.text,
              },
            }
          : {}),
      })
    : next;
  const updated = payloads.slice();
  updated[index] = nextWithMetadata;
  return updated;
};
