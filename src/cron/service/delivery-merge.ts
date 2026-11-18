import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { CronDelivery, CronDeliveryPatch } from "../types.js";

export function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: CronDeliveryPatch,
  implicitMode: CronDelivery["mode"],
): CronDelivery | undefined {
  const hasCompletionDestinationPatch = "completionDestination" in patch;
  const next: CronDelivery = {
    mode: existing ? existing.mode : implicitMode,
    target: existing?.target,
    directPolicy: existing?.directPolicy,
    channel: existing?.channel,
    to: existing?.to,
    threadId: existing?.threadId,
    accountId: existing?.accountId,
    completionDestination: existing?.completionDestination,
  };

  if (typeof patch.mode === "string") {
    const previousMode = next.mode;
    next.mode = patch.mode;
    if (previousMode !== next.mode && (previousMode === "webhook" || next.mode === "webhook")) {
      // `to` has different meaning for channel targets and webhook URLs; clear
      // it when crossing that boundary so stale destinations do not leak.
      next.to = undefined;
    }
    if (next.mode === "webhook") {
      next.target = undefined;
      next.directPolicy = undefined;
      next.channel = undefined;
      next.threadId = undefined;
      next.accountId = undefined;
    }
    if (!hasCompletionDestinationPatch && (next.mode === "none" || next.mode === "webhook")) {
      next.completionDestination = undefined;
    }
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("target" in patch) {
    next.target = patch.target ?? undefined;
  }
  if ("directPolicy" in patch) {
    next.directPolicy = patch.directPolicy ?? undefined;
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("threadId" in patch) {
    next.threadId = normalizeOptionalThreadValue(patch.threadId);
  }
  if ("accountId" in patch) {
    next.accountId = normalizeOptionalString(patch.accountId);
  }
  if (hasCompletionDestinationPatch) {
    if (patch.completionDestination == null) {
      next.completionDestination = undefined;
    } else {
      const to = normalizeOptionalString(patch.completionDestination.to);
      next.completionDestination = {
        mode: "webhook",
        ...(to ? { to } : {}),
      };
    }
  }

  if (
    existing === undefined &&
    !("mode" in patch) &&
    next.target === undefined &&
    next.directPolicy === undefined &&
    next.channel === undefined &&
    next.to === undefined &&
    next.threadId === undefined &&
    next.accountId === undefined &&
    next.completionDestination === undefined
  ) {
    // Clearing an absent override must preserve implicit detached-job delivery.
    return undefined;
  }

  return next;
}
