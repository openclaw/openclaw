import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveEffectiveCompactionReserveTokens } from "../../agents/agent-compaction-constants.js";
import { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/agent-settings.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveMemoryFlushPlan,
  type MemoryFlushPlanResolution,
  type MemoryFlushToolsPlan,
} from "../../plugins/memory-state.js";
import { isSilentReplyPayloadText } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

const log = createSubsystemLogger("auto-reply/memory-flush");
const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4_000;
const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

type MemoryFlushTiming = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
};

type ResolvedMemoryFlushPlan = MemoryFlushPlanResolution["plan"] & MemoryFlushTiming;

export type MemoryFlushPlanForRunResolution = Omit<MemoryFlushPlanResolution, "plan"> & {
  plan: ResolvedMemoryFlushPlan;
};

/** Resolve host-owned flush timing from config and the active model context window. */
function resolveMemoryFlushTiming(params: {
  cfg?: OpenClawConfig;
  contextWindowTokens?: number;
}): MemoryFlushTiming | null {
  const defaults = params.cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (defaults?.enabled === false) {
    return null;
  }

  // Invalid config values retain the established defaults instead of changing flush admission.
  let softThresholdTokens = Math.floor(
    asNonNegativeFiniteNumber(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  );
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  let reserveTokensFloor = DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR;
  const contextWindowTokens = Math.floor(
    asNonNegativeFiniteNumber(params.contextWindowTokens) ?? 0,
  );
  if (contextWindowTokens > 0) {
    // Small model windows cap both reserved compaction space and the earlier flush margin.
    reserveTokensFloor = resolveEffectiveCompactionReserveTokens({
      contextTokenBudget: contextWindowTokens,
      reserveTokens: reserveTokensFloor,
    });
    softThresholdTokens = Math.min(
      softThresholdTokens,
      Math.floor((contextWindowTokens - reserveTokensFloor) / 2),
    );
  }

  const model = defaults?.model?.trim() || undefined;
  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    ...(model ? { model } : {}),
  };
}

/** Narrow the provider-tool persistence arm; file plans never name persistence tools. */
export function isToolsMemoryFlushPlan<Plan extends MemoryFlushPlanResolution["plan"]>(
  plan: Plan,
): plan is Extract<Plan, MemoryFlushToolsPlan> {
  return plan.persistenceToolNames !== undefined;
}

/** Admit file plans and only the selected slot owner's tool plans for execution. */
export function resolveMemoryFlushPlanForRun(
  params: Parameters<typeof resolveMemoryFlushPlan>[0],
): MemoryFlushPlanForRunResolution | null {
  const timing = resolveMemoryFlushTiming(params);
  if (!timing) {
    return null;
  }
  const resolution = resolveMemoryFlushPlan(params);
  if (resolution && isToolsMemoryFlushPlan(resolution.plan) && !resolution.selectedSlotOwner) {
    log.warn(
      `memory flush skipped: plugin "${resolution.pluginId}" supplied a tools-arm plan but is not the selected memory slot owner`,
    );
    return null;
  }
  if (!resolution) {
    return null;
  }
  if (isToolsMemoryFlushPlan(resolution.plan)) {
    const persistenceNames = new Set(resolution.plan.persistenceToolNames);
    const overlappingNames = [
      ...new Set(
        (resolution.plan.lookupToolNames ?? []).filter((name) => persistenceNames.has(name)),
      ),
    ];
    if (overlappingNames.length > 0) {
      log.warn(
        `memory flush skipped: plugin "${resolution.pluginId}" declared overlapping lookup and persistence tools (${overlappingNames.join(", ")})`,
      );
      return null;
    }
  }
  // Providers own content and persistence; defined timing values deliberately override the host.
  return {
    ...resolution,
    plan: {
      ...resolution.plan,
      softThresholdTokens: resolution.plan.softThresholdTokens ?? timing.softThresholdTokens,
      forceFlushTranscriptBytes:
        resolution.plan.forceFlushTranscriptBytes ?? timing.forceFlushTranscriptBytes,
      reserveTokensFloor: resolution.plan.reserveTokensFloor ?? timing.reserveTokensFloor,
      // A file plan's omitted model keeps the session's model, as file plans always have;
      // tool plans inherit the configured flush model.
      model: isToolsMemoryFlushPlan(resolution.plan)
        ? (resolution.plan.model ?? timing.model)
        : resolution.plan.model,
    },
  };
}

/** Recognize deliberate silence only in the final assistant output. */
export function memoryFlushResultIsSilent(result: {
  payloads?: readonly ReplyPayload[];
  meta?: { finalAssistantRawText?: string; finalAssistantVisibleText?: string };
}): boolean {
  const finalText = result.meta?.finalAssistantVisibleText ?? result.meta?.finalAssistantRawText;
  return isSilentReplyPayloadText(finalText ?? result.payloads?.at(-1)?.text);
}
