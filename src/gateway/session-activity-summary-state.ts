import type { SessionActivitySummary } from "../../packages/gateway-protocol/src/schema/sessions-activity-summary.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import {
  ACTIVITY_SUMMARY_FORMAT_REVISION,
  readSessionActivitySummary,
} from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionTranscriptWatermark } from "../config/sessions/session-accessor.sqlite-transcript-watermark-read.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

export type ActivitySummaryTarget = { key: string; agentId: string };
type PendingState = {
  sessionId: string;
  storePath: string;
  lifecycleRevision?: string;
  state: SessionActivitySummary["state"];
};
const pending = new Map<string, PendingState & { owner: symbol }>();
export const activitySummaryScope = (target: ActivitySummaryTarget) =>
  `${target.agentId}\0${target.key}`;
export const sessionActivitySummaryOwnerIsCurrent = (
  target: ActivitySummaryTarget,
  owner: symbol,
) => pending.get(activitySummaryScope(target))?.owner === owner;
export function setSessionActivitySummaryState(
  target: ActivitySummaryTarget,
  owner: symbol,
  value?: PendingState,
  force = false,
): boolean {
  const key = activitySummaryScope(target);
  const existing = pending.get(key);
  if (value) {
    if (
      !force &&
      existing?.owner === owner &&
      existing.sessionId === value.sessionId &&
      existing.storePath === value.storePath &&
      existing.lifecycleRevision === value.lifecycleRevision &&
      existing.state === value.state
    ) {
      return false;
    }
    pending.set(key, { ...value, owner });
  } else if (existing?.owner === owner) {
    pending.delete(key);
  } else {
    return false;
  }
  sessionChanges.emit({
    sessionKey: target.key,
    agentId: target.agentId,
    scope: "runtime",
    facts: { kind: "unchanged" },
  });
  return true;
}

/** Presentation consumes the watermark prepared with the row; it never opens its transcript. */
export function projectSessionActivitySummary(
  params: ActivitySummaryTarget & {
    cfg: OpenClawConfig;
    entry: SessionEntry | undefined;
    enabled?: boolean;
    watermark?: SessionTranscriptWatermark;
  },
): SessionActivitySummary | undefined {
  const { entry } = params;
  if (!entry) {
    return undefined;
  }
  if (!entry.sessionId || entry.initializationPending) {
    return { state: "unavailable" };
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const summary = readSessionActivitySummary(entry);
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.key,
    storeAgentId: params.agentId,
  });
  const runtime = pending.get(activitySummaryScope({ key: canonicalKey, agentId: params.agentId }));
  const validRuntime =
    runtime &&
    runtime.storePath === storePath &&
    runtime.sessionId === entry.sessionId &&
    runtime.lifecycleRevision === entry.lifecycleRevision
      ? runtime
      : undefined;
  const enabled =
    params.enabled ??
    Boolean(resolveUtilityModelRefForAgent({ cfg: params.cfg, agentId: params.agentId }));
  const watermark = params.watermark;
  const fresh =
    summary &&
    summary.formatRevision === ACTIVITY_SUMMARY_FORMAT_REVISION &&
    summary.coveredMessages === summary.totalMessages &&
    watermark?.generation === summary.generation &&
    watermark.maxSeq === summary.maxSeq;
  return {
    ...(summary?.text ? { text: summary.text, updatedAt: summary.updatedAt } : {}),
    state: !enabled
      ? "unavailable"
      : validRuntime?.state === "updating" || validRuntime?.state === "unavailable"
        ? validRuntime.state
        : fresh
          ? "current"
          : "stale",
  };
}
