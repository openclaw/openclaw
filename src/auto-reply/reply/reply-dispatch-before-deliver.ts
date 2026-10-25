import { raceWithTimeout } from "@openclaw/retry";
import {
  collectReplyMediaEntries,
  recordReplyPayloadMediaSelectionChange,
} from "../../infra/outbound/reply-media-entries.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type {
  ReplyDispatchBeforeDeliver,
  ReplyDispatchBeforeDeliverOptions,
  ReplyDispatchRuntimeInfo,
} from "./reply-dispatcher.types.js";

export const DEFAULT_BEFORE_DELIVER_TIMEOUT_MS = 15_000;

type ReplyDispatchBeforeDeliverStage = { hook: ReplyDispatchBeforeDeliver; timeoutMs?: number };

type ReplyDispatchBeforeDeliverStageInput =
  | ReplyDispatchBeforeDeliver
  | { hook: ReplyDispatchBeforeDeliver; options?: ReplyDispatchBeforeDeliverOptions }
  | undefined;

type ReplyDispatchBeforeDeliverStages = readonly ReplyDispatchBeforeDeliverStage[];
const stagesByHook = new WeakMap<ReplyDispatchBeforeDeliver, ReplyDispatchBeforeDeliverStages>();

export async function runReplyDispatchBeforeDeliverStage(
  stage: ReplyDispatchBeforeDeliverStage,
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
): Promise<ReplyPayload | null> {
  if (!stage.timeoutMs) {
    return await stage.hook(payload, info);
  }
  return await raceWithTimeout(
    () => Promise.resolve(stage.hook(payload, info)),
    stage.timeoutMs,
    () => {
      throw new Error(`beforeDeliver timed out after ${stage.timeoutMs}ms`);
    },
    { ref: false },
  );
}

export function composeReplyDispatchBeforeDeliver(
  ...hooks: ReplyDispatchBeforeDeliverStageInput[]
): ReplyDispatchBeforeDeliver | undefined {
  const stages = hooks.flatMap((input): readonly ReplyDispatchBeforeDeliverStage[] => {
    if (!input) {
      return [];
    }
    const hook = typeof input === "function" ? input : input.hook;
    const existing = stagesByHook.get(hook);
    if (existing) {
      return existing;
    }
    const options = typeof input === "function" ? undefined : input.options;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_BEFORE_DELIVER_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("beforeDeliver timeoutMs must be a positive finite number");
    }
    return [
      {
        hook,
        timeoutMs,
      },
    ];
  });
  if (stages.length === 0) {
    return undefined;
  }
  const composed: ReplyDispatchBeforeDeliver = async (payload, info) => {
    let current = payload;
    for (const stage of stages) {
      const previousMediaUrls: string[] = collectReplyMediaEntries(current).map(({ url }) => url);
      const next = await runReplyDispatchBeforeDeliverStage(stage, current, info);
      if (!next) {
        return null;
      }
      current = recordReplyPayloadMediaSelectionChange(
        previousMediaUrls,
        copyReplyPayloadMetadata(current, next),
      );
    }
    return current;
  };
  stagesByHook.set(composed, stages);
  return composed;
}

export function markReplyDispatchBeforeDeliverDeadlineOwned(
  hook: ReplyDispatchBeforeDeliver,
): ReplyDispatchBeforeDeliver {
  stagesByHook.set(hook, [{ hook }]);
  return hook;
}
