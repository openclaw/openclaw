import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  type ModelCostConfig,
} from "../../utils/usage-format.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveResponseTemplate,
  type ResponseTemplateContext,
} from "./response-prefix-template.js";

export const formatResponseUsageLine = (params: {
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  showCost: boolean;
  costConfig?: ModelCostConfig;
  mode?: "tokens" | "full";
  modelLabel?: string;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  contextPercent?: number;
  sessionKey?: string;
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
  const mode = params.mode ?? "tokens";
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

  const parts = [`Usage: ${inputLabel} in / ${outputLabel} out`];
  if ((typeof cacheRead === "number" && cacheRead > 0) || (typeof cacheWrite === "number" && cacheWrite > 0)) {
    parts.push(`cache ${formatTokenCount(cacheRead ?? 0)} cached / ${formatTokenCount(cacheWrite ?? 0)} new`);
  }
  if (mode === "full") {
    const contextUsed =
      typeof params.contextUsedTokens === "number" ? formatTokenCount(params.contextUsedTokens) : undefined;
    const contextMax =
      typeof params.contextMaxTokens === "number" && Number.isFinite(params.contextMaxTokens) && params.contextMaxTokens > 0
        ? formatTokenCount(params.contextMaxTokens)
        : undefined;
    const contextPercent =
      typeof params.contextPercent === "number" && Number.isFinite(params.contextPercent)
        ? `${Math.round(params.contextPercent)}%`
        : undefined;

    if (contextUsed && contextMax) {
      parts.push(`ctx ${contextUsed}/${contextMax}${contextPercent ? ` (${contextPercent})` : ""}`);
    } else if (contextUsed && contextPercent) {
      parts.push(`ctx ${contextUsed} (${contextPercent})`);
    } else if (contextUsed) {
      parts.push(`ctx ${contextUsed}`);
    }
    if (params.modelLabel) {
      parts.push(`model ${params.modelLabel}`);
    }
    if (params.sessionKey) {
      parts.push(`session \`${params.sessionKey}\``);
    }
  }
  if (costLabel) {
    parts.push(`est ${costLabel}`);
  }
  return parts.join(" · ");
};

function findLastTextPayloadIndex(payloads: ReplyPayload[]): number {
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    if (payloads[i]?.text) {
      return i;
    }
  }
  return -1;
}

export const formatResponseFooterBlock = (params: {
  template?: string;
  context: ResponseTemplateContext;
}): string | null => {
  const resolved = resolveResponseTemplate(params.template, params.context);
  if (!resolved) {
    return null;
  }
  const block = resolved.replace(/^\n+|\n+$/g, "");
  return block.trim().length > 0 ? block : null;
};

export const appendFooterBlock = (payloads: ReplyPayload[], block: string): ReplyPayload[] => {
  const cleanBlock = block.replace(/^\n+|\n+$/g, "");
  if (!cleanBlock.trim()) {
    return payloads;
  }
  const index = findLastTextPayloadIndex(payloads);
  if (index === -1) {
    return [...payloads, { text: cleanBlock }];
  }
  const existing = payloads[index];
  const existingText = (existing.text ?? "").replace(/\n+$/g, "");
  const next = {
    ...existing,
    text: `${existingText}\n\n${cleanBlock}`,
  };
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};

export function composeFooterBlock(params: {
  usageLine?: string;
  footerBlock?: string;
  footerConsumesUsage?: boolean;
}): string | null {
  const usageLine = params.usageLine?.trim();
  const footerBlock = params.footerBlock?.trim();
  if (usageLine && footerBlock) {
    return params.footerConsumesUsage ? footerBlock : `${usageLine}\n${footerBlock}`;
  }
  return usageLine ?? footerBlock ?? null;
}

export const appendUsageLine = (payloads: ReplyPayload[], line: string): ReplyPayload[] => {
  const index = findLastTextPayloadIndex(payloads);
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
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};
