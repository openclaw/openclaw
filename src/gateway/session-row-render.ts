import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import {
  SESSION_DASHBOARD_ROW_FIELDS,
  SESSION_ROW_DETAIL_FIELDS,
  SESSION_SIDEBAR_ROW_FIELDS,
} from "../../packages/gateway-protocol/src/session-row-fields.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import type { VisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import { sessionTitleRequests } from "./session-title-state.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import { presentPreparedSessionRow, type PreparedSessionRow } from "./session-utils-row.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export type SessionRowRenderContext = Pick<
  SessionListRowContext,
  "subagentRuns" | "projectedAgentRuns" | "projectedSubagentActivity"
> & { now: number };

export type SnapshotOptions = {
  now?: number;
  excludedChildKeys?: ReadonlySet<string>;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  active?: boolean;
  subagentRuns?: SessionListRowContext["subagentRuns"];
  preparedFacts?: ReturnType<ReturnType<typeof readSessionRowFacts>["present"]>;
};

export type SessionRowPresentationOptions = Omit<
  SnapshotOptions,
  "now" | "active" | "subagentRuns" | "preparedFacts"
> & {
  includeActivitySummary?: boolean;
  rowMode?: SessionsListParams["rowMode"];
  omitSentinelChildren?: boolean;
  childArchiveFilter?: SessionsListParams["archived"];
};

export type PreparedSessionRowRecord = {
  materialized: PreparedSessionRow;
  activeModel?: { provider: string; model: string };
  preparedFacts: SnapshotOptions["preparedFacts"];
  hasBoard: GatewaySessionRow["hasBoard"];
  titlePending: boolean;
  options: Pick<
    SnapshotOptions,
    "includeDerivedTitles" | "includeLastMessage" | "excludedChildKeys"
  >;
};

/** Capture live host facts once before transferring pure presentation work. */
export function captureSessionRowPresentation(
  record: {
    key: string;
    agentId: string;
    storeTarget: SessionStoreTarget;
    entry: SessionEntry;
    materialized: PreparedSessionRow;
    fallbackModel?: { provider: string; model: string };
    facts?: ReturnType<typeof readSessionRowFacts>;
    hasBoard?: boolean;
  },
  context: SessionListRowContext,
  options: SnapshotOptions = {},
): PreparedSessionRowRecord {
  const live = resolveProjectedAgentRunModel({
    agentId: record.agentId,
    sessionId: record.entry.sessionId,
    index: context.projectedAgentRuns!,
  });
  const active = options.active ?? live !== undefined;
  const {
    entry,
    parsedKey,
    freshSessionTotalTokens,
    usageByFallbackModel,
    estimatedCostUsd,
    lightweight,
    childLinks,
  } = record.materialized.source;
  return {
    materialized: {
      row: record.materialized.row,
      source: {
        entry,
        parsedKey,
        freshSessionTotalTokens,
        usageByFallbackModel,
        estimatedCostUsd,
        lightweight,
        childLinks,
      },
    },
    activeModel: active ? (live ?? undefined) : record.fallbackModel,
    preparedFacts: options.preparedFacts ?? record.facts?.present(),
    hasBoard: record.hasBoard,
    // Naming belongs to the in-flight owner, not persisted or materialized row state.
    titlePending:
      sessionTitleRequests.get({
        storePath: record.storeTarget.storePath,
        sessionKey: record.key,
        sessionId: record.entry.sessionId,
      }) !== undefined,
    options: {
      includeDerivedTitles: options.includeDerivedTitles,
      includeLastMessage: options.includeLastMessage,
      excludedChildKeys: options.excludedChildKeys,
    },
  };
}

/** Presentation consumes captured facts; live ownership and disclosure stay with the caller. */
export function renderSessionRowRecord(
  input: PreparedSessionRowRecord,
  context: SessionRowRenderContext,
): GatewaySessionRow {
  const row = presentPreparedSessionRow(input.materialized, {
    ...context,
    activeModel: input.activeModel,
    excludedChildKeys: input.options.excludedChildKeys,
  });
  Object.assign(row, input.preparedFacts);
  row.hasBoard = input.hasBoard;
  row.titlePending = input.titlePending;
  if (!input.options.includeDerivedTitles) {
    row.derivedTitle = undefined;
  }
  if (!input.options.includeLastMessage) {
    row.lastMessagePreview = undefined;
  }
  return row;
}

export type PreparedSessionRowRender = PreparedSessionRowRecord & {
  options: SessionRowPresentationOptions;
  childOwnerSessionKeys: readonly string[];
  supportsUltrafast: boolean;
  sourceSwarm: GatewaySessionRow["swarm"];
  excludedSwarmKeys?: ReadonlySet<string>;
  run: ReturnType<VisibleActiveSessionRunProjector> | undefined;
  viewerFacts?: Pick<
    GatewaySessionRow,
    "visibility" | "hiddenFromInvolvingMe" | "sharingRole" | "sendDisabledReason"
  >;
  canEnsure?: boolean;
};

export function renderPreparedSessionRow(
  input: PreparedSessionRowRender,
  context: SessionRowRenderContext,
): GatewaySessionRow {
  const { options, sourceSwarm, excludedSwarmKeys, run, viewerFacts, canEnsure } = input;
  const row = renderSessionRowRecord(input, context);
  row.childOwnerSessionKeys = [...input.childOwnerSessionKeys];
  if (!input.supportsUltrafast) {
    if (row.fastMode === "ultrafast") {
      row.fastMode = true;
    }
    if (row.effectiveFastMode === "ultrafast") {
      row.effectiveFastMode = true;
    }
  }
  if (sourceSwarm) {
    row.swarm = { ...sourceSwarm, groups: [] };
    for (const group of sourceSwarm.groups) {
      row.swarm.groups.push({
        ...group,
        children: group.children?.filter(({ sessionKey }) => !excludedSwarmKeys?.has(sessionKey)),
      });
    }
  }
  if (run) {
    Object.assign(
      row,
      projectGatewaySessionActiveRun(run, row.status),
      run.runIds === undefined ? {} : { activeRunIds: run.runIds },
    );
  }
  if (options.includeActivitySummary === false) {
    row.activitySummary = undefined;
  }
  if (viewerFacts) {
    Object.assign(row, viewerFacts);
    if (row.activitySummary) {
      row.activitySummary = { ...row.activitySummary, canEnsure: canEnsure === true };
    }
  }
  if (options.rowMode === "dashboard" || options.rowMode === "sidebar") {
    const fields =
      options.rowMode === "sidebar" ? SESSION_SIDEBAR_ROW_FIELDS : SESSION_DASHBOARD_ROW_FIELDS;
    for (const field of Object.keys(row)) {
      if (!fields.has(field)) {
        Reflect.deleteProperty(row, field);
      }
    }
    row.rowMode = options.rowMode;
  } else if (options.rowMode === "compact") {
    for (const field of SESSION_ROW_DETAIL_FIELDS) {
      delete row[field];
    }
    row.rowMode = "compact";
  }
  if (options.omitSentinelChildren) {
    row.childSessions = undefined;
    row.hasActiveSubagentRun = undefined;
  }
  if (
    row.childSessions?.length &&
    options.childArchiveFilter !== undefined &&
    options.childArchiveFilter !== "all"
  ) {
    let excluded: Set<string> | undefined;
    for (const { key, entry } of input.materialized.source.childLinks ?? []) {
      if (!matchesSessionArchiveFilter(entry, options.childArchiveFilter)) {
        (excluded ??= new Set()).add(key);
      }
    }
    if (excluded) {
      row.childSessions = row.childSessions.filter((key) => !excluded.has(key));
    }
  }
  return row;
}
