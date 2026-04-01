import { estimateUsageCost, formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { derivePromptTokens } from "../../agents/usage.js";
import type { ReplyPayload } from "../types.js";

function resolveDisplayedInputTokens(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}): number | undefined {
  const promptInput = derivePromptTokens({
    input: params.input,
    cacheRead: params.cacheRead,
    cacheWrite: params.cacheWrite,
  });
  if (typeof promptInput !== "number") {
    return params.input;
  }

  if (typeof params.total === "number" && typeof params.output === "number") {
    const promptFromTotal = params.total - params.output;
    if (
      Number.isFinite(promptFromTotal) &&
      promptFromTotal >= 0 &&
      promptInput > promptFromTotal
    ) {
      return typeof params.input === "number" ? params.input : promptFromTotal;
    }
  }

  return promptInput;
}

export const formatResponseUsageLine = (params: {
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  showCost: boolean;
  costConfig?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}): string | null => {
  const usage = params.usage;
  if (!usage) {
    return null;
  }
  const input = usage.input;
  const output = usage.output;
  const inputDisplay = resolveDisplayedInputTokens({
    input,
    output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.total,
  });
  if (typeof inputDisplay !== "number" && typeof output !== "number") {
    return null;
  }
  const inputLabel = typeof inputDisplay === "number" ? formatTokenCount(inputDisplay) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
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
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${inputLabel} in / ${outputLabel} out${suffix}`;
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
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};
