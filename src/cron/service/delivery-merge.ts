import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type {
  CronDelivery,
  CronDeliveryPatch,
  CronFailureAlert,
  CronFailureAlertPatch,
} from "../types.js";

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
    bestEffort: existing?.bestEffort,
    completionDestination: existing?.completionDestination,
    failureDestination: existing?.failureDestination,
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
  if (typeof patch.bestEffort === "boolean") {
    next.bestEffort = patch.bestEffort;
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
  if ("failureDestination" in patch) {
    if (patch.failureDestination == null) {
      next.failureDestination = undefined;
    } else {
      const existingFd = next.failureDestination;
      const patchFd = patch.failureDestination;
      const nextFd: typeof next.failureDestination = {};
      if (existingFd) {
        for (const field of ["channel", "to", "accountId"] as const) {
          if (Object.hasOwn(existingFd, field)) {
            nextFd[field] = existingFd[field];
          }
        }
        if (Object.hasOwn(existingFd, "mode")) {
          nextFd.mode = existingFd.mode;
        }
      }
      if (patchFd) {
        for (const field of ["channel", "to", "accountId"] as const) {
          if (field in patchFd) {
            nextFd[field] = normalizeOptionalString(patchFd[field]);
          }
        }
        if ("mode" in patchFd) {
          const mode = normalizeOptionalString(patchFd.mode);
          nextFd.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
        }
      }
      const hasFailureDestination =
        Object.hasOwn(nextFd, "channel") ||
        Object.hasOwn(nextFd, "to") ||
        Object.hasOwn(nextFd, "accountId") ||
        Object.hasOwn(nextFd, "mode");
      next.failureDestination = hasFailureDestination ? nextFd : undefined;
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
    next.bestEffort === undefined &&
    next.completionDestination === undefined &&
    next.failureDestination === undefined
  ) {
    // Clearing an absent override must preserve implicit detached-job delivery.
    return undefined;
  }

  return next;
}

export function mergeCronFailureAlert(
  existing: CronFailureAlert | false | undefined,
  patch: CronFailureAlertPatch | false | null | undefined,
): CronFailureAlert | false | undefined {
  if (patch === false) {
    return false;
  }
  if (patch === null) {
    return undefined;
  }
  if (patch === undefined) {
    return existing;
  }
  const base = existing === false || existing === undefined ? {} : existing;
  const next: CronFailureAlert = { ...base };

  if ("after" in patch) {
    const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
    next.after = after > 0 ? Math.floor(after) : undefined;
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("cooldownMs" in patch) {
    const cooldownMs =
      typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)
        ? patch.cooldownMs
        : -1;
    next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : undefined;
  }
  if ("includeSkipped" in patch) {
    next.includeSkipped =
      typeof patch.includeSkipped === "boolean" ? patch.includeSkipped : undefined;
  }
  if ("mode" in patch) {
    const mode = normalizeOptionalString(patch.mode);
    next.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
  }
  if ("accountId" in patch) {
    next.accountId = normalizeOptionalString(patch.accountId);
  }

  return next;
}
