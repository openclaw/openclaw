import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as text } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  isDashboardSessionKey,
  isSubagentSessionKey,
} from "../../lib/sessions/session-key.ts";

/** The session's direct children as the pane holds them. */
export type SubagentRoster = {
  /** Owner-qualified ancestry key from the pane's admitted read target. */
  subagentParentKey?: string;
  subagentSessions?: readonly GatewaySessionRow[];
  /** True once the pane's own child query answered; seeded rows can be partial. */
  subagentSessionsHydrated?: boolean;
  /**
   * True once the pane's own child query answered at least once. Seeded rows
   * take ancestry from the broad list, which outlives the child-link retention.
   */
  subagentSessionsRead?: boolean;
};

/** What a launch row needs to show its subagent's session and open it. */
export type SubagentRowContext = Pick<SubagentRoster, "subagentSessions" | "subagentParentKey"> & {
  /** Shows a subagent the Subagents panel lists. */
  onOpenSubagent?: (sessionKey: string) => void;
  /** Opens a session; any other subagent opens this way. */
  onOpenSession?: (sessionKey: string) => void;
};

export type SpawnedSubagent = {
  /** The short name the launch call gave the subagent. */
  label: string;
  /** Its session, when the roster holds it; `runtimeMs` only once it finished. */
  session?: {
    key: string;
    /** Whether the Subagents panel lists it. */
    listed: boolean;
    running: boolean;
    runtimeMs: number | null;
    /** How it ended, when not by finishing its work. */
    ended?: "failed" | "stopped";
  };
};

type LaunchCard = Pick<ToolCard, "name" | "args" | "details" | "outputText">;

/**
 * What one `sessions_spawn` call started. It opened a session in its own right,
 * an ordinary operation and not a subagent's, when it was asked to with
 * `visible` or was answered with a dashboard session.
 */
function readLaunch(card: LaunchCard) {
  if (card.name.trim().toLowerCase() !== "sessions_spawn") {
    return null;
  }
  const args = asRecord(card.args);
  // History keeps the result as text; only a live result still carries its details.
  const childKey =
    text(asRecord(card.details)?.childSessionKey) ??
    text(safeParseJsonRecord(card.outputText ?? "")?.childSessionKey);
  return {
    label: text(args?.label),
    childKey,
    ownSession:
      args?.visible === true || (childKey !== undefined && isDashboardSessionKey(childKey)),
  };
}

/** The calls among `cards` that a count of subagents must leave out. */
export function ownSessionLaunchCalls(cards: readonly ToolCard[]): Set<string> {
  return new Set(
    cards.flatMap((card) => (card.callId && readLaunch(card)?.ownSession ? [card.callId] : [])),
  );
}

/** The name a `sessions_spawn` call gave its subagent, shown instead of its assignment. */
export function spawnedSubagentLabel(card: LaunchCard): string | undefined {
  const launch = readLaunch(card);
  return launch && !launch.ownSession ? launch.label : undefined;
}

export function isSubagentsPanelSession(row: GatewaySessionRow): boolean {
  return row.classification === "subagent" || isSubagentSessionKey(row.key);
}

/** A subagent that handed off to its own subagents is still at work. */
export function isUnfinishedSubagent(row: GatewaySessionRow): boolean {
  return isSessionRunActive(row) || row.hasActiveSubagentRun === true;
}

function finishedRuntimeMs(row: GatewaySessionRow): number | null {
  const { runtimeMs, startedAt, endedAt } = row;
  if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs) && runtimeMs >= 0) {
    return runtimeMs;
  }
  return typeof startedAt === "number" && typeof endedAt === "number" && endedAt >= startedAt
    ? endedAt - startedAt
    : null;
}

function endedWithoutFinishing(row: GatewaySessionRow): "failed" | "stopped" | undefined {
  if (row.status === "failed" || row.status === "timeout") {
    return "failed";
  }
  return row.status === "killed" || row.status === "interrupted" ? "stopped" : undefined;
}

/**
 * Only the session its own result names is this launch's subagent. A launch
 * still in flight, or one that was refused, has none: its label alone can
 * belong to an earlier subagent or to a retry.
 */
export function resolveSpawnedSubagent(
  card: LaunchCard,
  rows: readonly GatewaySessionRow[] | undefined,
): SpawnedSubagent | null {
  const launch = readLaunch(card);
  if (!launch?.label || launch.ownSession) {
    return null;
  }
  const { label, childKey } = launch;
  const row = childKey
    ? rows?.find((candidate) => areUiSessionKeysEquivalent(candidate.key, childKey))
    : undefined;
  if (!row) {
    return { label };
  }
  const running = isUnfinishedSubagent(row);
  const ended = running ? undefined : endedWithoutFinishing(row);
  return {
    label,
    session: {
      key: row.key,
      listed: isSubagentsPanelSession(row),
      running,
      runtimeMs: running ? null : finishedRuntimeMs(row),
      ...(ended ? { ended } : {}),
    },
  };
}

const rosterKeys = new WeakMap<readonly GatewaySessionRow[], string>();

/**
 * Everything launch rows draw from the roster. Settled rows repaint when a
 * subagent starts or finishes, not when its activity patches or the roster's
 * order change.
 */
export function spawnedSubagentsRenderKey(rows: readonly GatewaySessionRow[] | undefined): string {
  if (!rows || rows.length === 0) {
    return "";
  }
  let key = rosterKeys.get(rows);
  if (key === undefined) {
    key = rows
      .map((row) => {
        const running = isUnfinishedSubagent(row);
        return JSON.stringify([
          row.key,
          isSubagentsPanelSession(row),
          running,
          running ? null : finishedRuntimeMs(row),
          running ? null : endedWithoutFinishing(row),
        ]);
      })
      .toSorted()
      .join("\n");
    rosterKeys.set(rows, key);
  }
  return key;
}
