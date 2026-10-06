import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readLoggingConfig } from "../logging/config.js";
import {
  captureModelVisibleRedactionPolicy,
  matchesModelVisibleRedactionPolicy,
} from "../logging/redact-internal-state.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type {
  RuntimeSessionFacts,
  RuntimeSessionFactsSelectionResult,
} from "../plugins/runtime/types-session-facts.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";
import type { ControlUiSessionPullRequestSnapshot } from "./control-ui-contract.js";
import {
  resolveProjectedControlUiSessionPrTarget,
  type ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { ResolvedInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.types.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import { prepareProjectedSessionSharing, resolveSessionVisibility } from "./session-sharing.js";
import { projectGatewaySessionRunState } from "./session-utils-display.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const SESSION_FACTS_PR_LOAD_LIMIT = 8;
const PR_RETRY_MS = 60_000;
const PR_RETRY_MAX_MS = 15 * 60_000;
export type SelectedFacts = RuntimeSessionFactsSelectionResult["sessions"][number];
export type SelectedPrFacts = {
  row: GatewaySessionRow;
  redaction: ReturnType<typeof sessionFactsRedactionPolicy>;
  owner: ResolvedInProcessGatewayDispatch["context"]["controlUiSessionPullRequests"];
  facts: RuntimeSessionFacts;
  selected: SelectedFacts;
  retry?: { at: number; delayMs: number };
};
let rowFacts = new WeakMap<
  GatewaySessionRow,
  {
    owner: ResolvedInProcessGatewayDispatch["context"]["controlUiSessionPullRequests"];
    prs: ControlUiSessionPullRequestSnapshot | undefined;
    facts: RuntimeSessionFacts;
    selected: SelectedFacts;
    preview: string | undefined;
    run: RuntimeSessionFacts["run"];
  }
>();

let redactionPolicy:
  | (ReturnType<typeof captureModelVisibleRedactionPolicy> & { revision: string })
  | undefined;

// Row identity survives redaction changes; cached text must follow the policy owner.
export function sessionFactsRedactionPolicy() {
  const logging = readLoggingConfig();
  if (!redactionPolicy || !matchesModelVisibleRedactionPolicy(redactionPolicy, logging)) {
    redactionPolicy = { ...captureModelVisibleRedactionPolicy(logging), revision: randomUUID() };
    rowFacts = new WeakMap();
  }
  return redactionPolicy;
}

export function safeText(value: string | undefined, limit: number): string | undefined {
  return value ? truncateUtf16Safe(redactToolPayloadText(value), limit) : undefined;
}

function projectPullRequests(
  pullRequests: ReadonlyArray<RuntimeSessionFacts["pullRequests"][number]>,
  source: "snapshot" | "retained" = "snapshot",
) {
  return pullRequests.map(({ number, state, url, title }) => ({
    number,
    state,
    ...(url ? { url } : {}),
    ...(source === "snapshot" && title ? { title: safeText(title, 120) } : {}),
  }));
}

/** Project only facts consumed by classifiers; full Gateway row presentation belongs to list/describe. */
export function prepareFactsRead(
  resolved: ResolvedInProcessGatewayDispatch,
  read: SessionRowReadView,
  authority?: { visibility: WeakMap<object, boolean> },
  prFacts?: Map<string, SelectedPrFacts>,
) {
  const redaction = sessionFactsRedactionPolicy();
  const now = Date.now();
  const { cfg, policyConfig, rowContext } = read.state;
  const sharing = prepareProjectedSessionSharing({
    cfg: policyConfig,
    client: resolved.client,
    isMember: (target, identityId) =>
      read
        .readMembership({
          agentId: target.agentId,
          key: target.storeKey,
          storePath: target.storePath,
        })
        ?.has(identityId) ?? false,
  });
  const active = createVisibleActiveSessionRunProjector(
    resolved.context,
    rowContext.projectedAgentRuns,
  );
  const currentRows = { ...rowContext, subagentRuns: rowContext.subagentRuns.atTime(now) };
  const prOwner = resolved.context.controlUiSessionPullRequests;
  let prLoads = 0;
  const admitPrLoad = () => prLoads++ < SESSION_FACTS_PR_LOAD_LIMIT;
  const prRetries: ControlUiSessionPrTarget[] = [];
  return {
    read(record: MaterializedRow) {
      if (
        record.entry.incognito ||
        resolveSessionVisibility(record.entry) === "draft" ||
        isIncognitoSessionKey(record.key)
      ) {
        return undefined;
      }
      let visible = authority?.visibility.get(record.entry);
      if (visible === undefined) {
        visible = sharing.entryFilter?.(record.key, record.entry) !== false;
        authority?.visibility.set(record.entry, visible);
      }
      if (!visible) {
        return undefined;
      }
      const row = record.materialized.row;
      const live = active({
        requestedKey: record.key,
        canonicalKey: record.key,
        sessionId: record.entry.sessionId,
        agentId: record.agentId,
        defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, record.key),
      });
      const temporal = projectGatewaySessionRunState({
        key: record.key,
        entry: record.entry,
        now,
        rowContext: currentRows,
      }).fields;
      const status = live.active ? (live.status ?? "running") : temporal.status;
      const run: RuntimeSessionFacts["run"] =
        live.active || status === "queued"
          ? "active"
          : status === "failed" ||
              status === "killed" ||
              status === "timeout" ||
              temporal.lastRunError
            ? "failed"
            : "idle";
      const prEligible = Boolean(row.worktree?.id || row.repositoryWorkspaceId);
      if (!prEligible) {
        prFacts?.delete(record.key);
      }
      const target = prEligible
        ? resolveProjectedControlUiSessionPrTarget(read.state.cfg, record)
        : undefined;
      const cachedPrs = target ? prOwner?.readPrepared(target, () => false) : undefined;
      const retained = prFacts?.get(record.key);
      const previous =
        retained &&
        retained.owner === prOwner &&
        retained.facts.sessionId === record.entry.sessionId &&
        retained.facts.lifecycleRevision === record.entry.lifecycleRevision
          ? retained
          : undefined;
      const retryDue =
        !previous?.retry ||
        previous.retry.at <= now ||
        previous.row !== row ||
        previous.facts.run !== run;
      const admitSelectedLoad = () => retryDue && admitPrLoad();
      const prs =
        cachedPrs ??
        (target
          ? prOwner?.readPrepared(target, prFacts ? admitSelectedLoad : admitPrLoad)
          : undefined);
      const prUnavailable = prEligible && (!prs || prs.status !== "ready" || prs.rateLimited);
      if (target && cachedPrs && prUnavailable && (!prFacts || retryDue)) {
        prRetries.push(target);
      }
      const previousFacts = rowFacts.get(row);
      const cached =
        previousFacts?.preview === row.lastMessagePreview && previousFacts?.run === run
          ? previousFacts
          : undefined;
      if (cached && cached.owner === prOwner && cached.prs === prs && (!prFacts || !prEligible)) {
        return cached;
      }
      const digest = row.observerDigest ? record.entry.observerDigest : undefined;
      const facts: RuntimeSessionFacts =
        cached && cached.owner === prOwner && cached.prs === prs
          ? cached.facts
          : freezeJsonSnapshot({
              key: record.key,
              sessionId: record.entry.sessionId,
              ...(record.entry.lifecycleRevision
                ? { lifecycleRevision: record.entry.lifecycleRevision }
                : {}),
              agentId: record.agentId,
              label: safeText(row.label ?? row.displayName, 240),
              derivedTitle: safeText(row.derivedTitle, 240),
              lastMessagePreview: safeText(
                row.lastMessagePreview
                  ? stripMarkdown(row.lastMessagePreview, { linkStyle: "label", stripHtml: true })
                      .replace(/\s+/gu, " ")
                      .trim()
                  : undefined,
                400,
              ),
              run,
              ...(digest
                ? {
                    observerDigest: {
                      health: digest.health,
                      headline: safeText(digest.headline, 120) ?? "",
                      assessment: safeText(digest.assessment, 320),
                      revision: digest.revision,
                    },
                  }
                : {}),
              pullRequests: projectPullRequests(prs?.pullRequests ?? []),
              ...(prUnavailable ? { pullRequestsUnavailable: true } : {}),
              ...(prs?.rateLimited || prs?.status === "rate-limited"
                ? { pullRequestsRateLimited: true }
                : {}),
              archived: row.archived === true,
              lastActivityAt: row.lastActivityAt ?? row.updatedAt ?? 0,
            });
      const result =
        cached && cached.owner === prOwner && cached.prs === prs
          ? cached
          : {
              owner: prOwner,
              prs,
              facts,
              selected: Object.freeze({ ...facts, isMain: row.isMain }),
              preview: row.lastMessagePreview,
              run,
            };
      if (result !== cached) {
        rowFacts.set(row, result);
      }
      if (prFacts && prEligible) {
        const stale =
          prUnavailable &&
          previous &&
          (previous.selected.pullRequestsStale ||
            (!previous.facts.pullRequestsUnavailable && !previous.facts.pullRequestsRateLimited));
        const delayMs = previous?.retry
          ? Math.min(previous.retry.delayMs * 2, PR_RETRY_MAX_MS)
          : PR_RETRY_MS;
        const retry = prUnavailable
          ? previous?.retry && previous.retry.at > now
            ? previous.retry
            : { at: now + delayMs, delayMs }
          : undefined;
        // Truncated retained titles cannot be re-redacted under a different policy.
        const selected = !stale
          ? result.selected
          : previous.facts === facts && previous.selected.pullRequestsStale
            ? previous.selected
            : Object.freeze({
                ...facts,
                isMain: row.isMain,
                pullRequests:
                  previous.redaction === redaction
                    ? previous.selected.pullRequests
                    : freezeJsonSnapshot(
                        projectPullRequests(previous.selected.pullRequests, "retained"),
                      ),
                pullRequestsStale: true as const,
              });
        prFacts.set(record.key, { row, redaction, owner: prOwner, facts, selected, retry });
        return { ...result, selected };
      }
      return result;
    },
    finish() {
      // Cold keys precede retries within each bounded batch.
      for (const target of prRetries) {
        prOwner?.readPrepared(target, admitPrLoad);
      }
    },
  };
}
