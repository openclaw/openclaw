import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import {
  resolveConfiguredThinkingDefault,
  resolveThinkingSelection,
} from "../../../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import {
  getSessionControllerMailbox,
  getExistingSessionControllerMailbox,
  sessionControllerMailboxes,
  clearSessionControllerMailbox,
  retireSessionControllerInput,
  type SessionControllerMailbox,
} from "../../../sessions/session-controller.mailbox.js";
import {
  captureSessionTarget,
  type SessionTarget,
} from "../../../sessions/session-controller.target.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
import { normalizeThinkLevel } from "../../thinking.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import type { FollowupRun, QueueDropPolicy, QueueSettings } from "./types.js";

export const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

export function* followupQueueSources(
  queue: Pick<SessionControllerMailbox, "items" | "summarySources" | "summaryElisions">,
): Generator<FollowupRun> {
  yield* queue.items;
  yield* queue.summarySources;
  for (const entry of queue.summaryElisions) {
    yield* entry.sources;
  }
}

export function getExistingFollowupQueue(
  key: string,
  target?: SessionTarget,
): SessionControllerMailbox | undefined {
  const cleaned = key.trim();
  if (!cleaned) {
    return undefined;
  }
  const mailbox = getExistingSessionControllerMailbox(cleaned, target);
  return mailbox && (mailbox.entries.length || mailbox.claim || mailbox.droppedCount)
    ? mailbox
    : undefined;
}

export function hasPendingFollowupQueueWork(
  keys: Iterable<string | undefined>,
  scope?: Pick<SessionTarget, "storeScope" | "agentId">,
): boolean {
  const seen = new Set<string>();
  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    // Keep candidates separate: an alias union can hide multiple queued owners.
    const queue = getExistingFollowupQueue(
      cleaned,
      scope
        ? captureSessionTarget({
            storeScope: scope.storeScope,
            sessionKey: cleaned,
            agentId: scope.agentId,
          })
        : undefined,
    );
    if (queue && (queue.items.length > 0 || queue.inFlight.size > 0 || queue.droppedCount > 0)) {
      return true;
    }
  }
  return false;
}

type SummaryElisionCapState = Pick<
  SessionControllerMailbox,
  "activeSummarySources" | "cap" | "summaryElisions" | "droppedCount"
>;

export function trimSummaryElisionsToCap(queue: SummaryElisionCapState): void {
  let sourceCount = queue.summaryElisions.reduce(
    (count, entry) =>
      count + entry.sources.filter((source) => !queue.activeSummarySources.has(source)).length,
    0,
  );
  while (sourceCount > queue.cap) {
    let evicted = false;
    for (const [entryIndex, entry] of queue.summaryElisions.entries()) {
      const sourceIndex = entry.sources.findIndex(
        (source) => !queue.activeSummarySources.has(source),
      );
      if (sourceIndex < 0) {
        continue;
      }
      const [source] = entry.sources.splice(sourceIndex, 1);
      entry.summaryLines.splice(sourceIndex, 1);
      entry.count = entry.sources.length;
      queue.droppedCount = Math.max(0, queue.droppedCount - 1);
      for (const [original, compact] of entry.sourceRefs) {
        if (compact === source) {
          entry.sourceRefs.delete(original);
        }
      }
      sourceCount -= 1;
      if (source) {
        source.onQueueDisposition?.("queue-cap-old");
        // Eviction closes selection synchronously; callback completion is asynchronous.
        if (source.controllerInput) {
          retireSessionControllerInput(source.controllerInput);
        }
      }
      if (entry.sources.length === 0) {
        queue.summaryElisions.splice(entryIndex, 1);
      }
      evicted = true;
      break;
    }
    if (!evicted) {
      // A deferred delivery temporarily retains at most one queue-cap-sized active set.
      return;
    }
  }
}

export function getFollowupQueue(
  key: string,
  settings: QueueSettings,
  target?: SessionTarget,
): SessionControllerMailbox {
  const mailbox = getSessionControllerMailbox(key, target);
  applyQueueRuntimeSettings({ target: mailbox, settings });
  trimSummaryElisionsToCap(mailbox);
  return mailbox;
}

/** @internal Exposed for unit tests only. */
export function clearFollowupQueue(key: string, captured?: SessionControllerMailbox): number {
  const queue = captured ?? getExistingSessionControllerMailbox(key.trim());
  return queue ? clearSessionControllerMailbox(queue, completeFollowupRunLifecycle) : 0;
}

export function clearRemovedQueuedAuthProfiles(params: {
  removedByAgent: ReadonlyMap<string, ReadonlySet<string>>;
  rewriteConfig: (cfg: OpenClawConfig) => OpenClawConfig;
}): void {
  const clearRun = (run: FollowupRun["run"]) => {
    const removed = params.removedByAgent.get(normalizeAgentId(run.agentId));
    if (!removed?.size) {
      return;
    }
    // Pending work retains config as well as a selected account. Clear both sources
    // so a later model switch cannot restore the deleted account from its snapshot.
    run.config = params.rewriteConfig(run.config);
    if (run.authProfileId && removed.has(run.authProfileId)) {
      delete run.authProfileId;
      delete run.authProfileIdSource;
    }
    const probe = run.autoFallbackPrimaryProbe;
    if (probe?.fallbackAuthProfileId && removed.has(probe.fallbackAuthProfileId)) {
      delete probe.fallbackAuthProfileId;
      delete probe.fallbackAuthProfileIdSource;
    }
  };
  for (const queue of sessionControllerMailboxes()) {
    if (queue.lastRun) {
      clearRun(queue.lastRun);
    }
    for (const item of followupQueueSources(queue)) {
      clearRun(item.run);
    }
  }
}

export function refreshQueuedFollowupSession(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
  nextProvider?: string;
  nextModel?: string;
  nextRouteResolution?: ModelFallbackRouteResolution;
  nextModelOverrideSource?: "auto" | "user";
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
  nextThinking?: {
    level?: string;
    catalog?: ModelCatalogEntry[];
    agentRuntime?: string | null;
  };
}): void {
  const queue = getExistingFollowupQueue(params.key);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const hasNextModelRoute = params.nextProvider !== undefined || params.nextModel !== undefined;
  const shouldRewriteModelSelection =
    hasNextModelRoute || Object.hasOwn(params, "nextModelOverrideSource");
  const shouldRewriteSelection =
    shouldRewriteModelSelection ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource") ||
    params.nextThinking !== undefined;
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }

  const rewriteRun = (run: FollowupRun["run"]) => {
    if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
      run.sessionId = params.nextSessionId!;
      const nextSessionFile = normalizeOptionalString(params.nextSessionFile);
      if (nextSessionFile) {
        run.sessionFile = nextSessionFile;
      }
    }
    if (shouldRewriteSelection) {
      if (params.nextProvider !== undefined) {
        run.provider = params.nextProvider;
      }
      if (params.nextModel !== undefined) {
        run.model = params.nextModel;
      }
      if (hasNextModelRoute) {
        run.requestedRouteResolution = params.nextRouteResolution ?? "raw";
      }
      if (shouldRewriteModelSelection) {
        delete run.hasAutoFallbackProvenance;
        delete run.autoFallbackPrimaryProbe;
      }
      if (Object.hasOwn(params, "nextModelOverrideSource")) {
        run.hasSessionModelOverride =
          params.nextModelOverrideSource !== undefined && Boolean(run.provider || run.model);
        run.modelOverrideSource = params.nextModelOverrideSource;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = normalizeOptionalString(params.nextAuthProfileId);
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
      if (params.nextThinking) {
        run.thinkingCatalog = params.nextThinking.catalog;
        const explicitLevel =
          run.thinkLevelOverride === "default"
            ? undefined
            : (run.thinkLevelOverride ?? normalizeThinkLevel(params.nextThinking.level));
        run.thinkingExplicit =
          explicitLevel !== undefined ||
          resolveConfiguredThinkingDefault({
            cfg: run.config,
            agentId: run.agentId,
            provider: run.provider,
            model: run.model,
          }) !== undefined;
        run.thinkLevel = resolveThinkingSelection({
          cfg: run.config,
          agentId: run.agentId,
          provider: run.provider,
          model: run.model,
          catalog: params.nextThinking.catalog,
          agentRuntime: params.nextThinking.agentRuntime,
          level: explicitLevel,
        }).requestedLevel;
      }
    }
  };

  if (queue.lastRun) {
    rewriteRun(queue.lastRun);
  }
  for (const item of followupQueueSources(queue)) {
    rewriteRun(item.run);
  }
}
