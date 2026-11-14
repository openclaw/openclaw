import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as text } from "@openclaw/normalization-core/string-coerce";
import { unwrapToolCallForDisplay } from "../../../../src/agents/tool-display-call.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
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
  /** The optional child read settled unsuccessfully; live parent facts still apply. */
  subagentSessionsUnavailable?: boolean;
  /** A newly named child is still awaiting a covering read before the wait can count it. */
  subagentSessionsPending?: boolean;
};

/** A child query can be hydrated before it observes its own parent. */
export function hasLoadedDetailsSubagents(
  details: SubagentRoster & { selectedSession?: GatewaySessionRow },
) {
  return (
    details.subagentSessionsHydrated &&
    !details.subagentSessionsPending &&
    details.subagentSessions?.some((row) =>
      areUiSessionKeysEquivalent(row.key, details.selectedSession?.key),
    )
  );
}

/** What a launch row needs to show its subagent's session and open it. */
export type SubagentRowContext = Pick<
  SubagentRoster,
  "subagentSessions" | "subagentParentKey" | "subagentSessionsHydrated" | "subagentSessionsPending"
> & {
  /** Shows a subagent the Subagents panel lists. */
  onOpenSubagent?: (sessionKey: string) => void;
  /** Opens a session; any other subagent opens this way. */
  onOpenSession?: (sessionKey: string) => void;
};

export type SpawnedSubagent = NonNullable<ReturnType<typeof resolveSpawnedSubagent>>;

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
  const result = asRecord(card.details) ?? safeParseJsonRecord(card.outputText ?? "");
  const childKey = text(result?.childSessionKey);
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

/**
 * The session a call starts or addresses by key: a launch, a message, a history
 * read, or a steer or stop. Undefined when the call names no session by key.
 */
function readAddressedSessionKey(card: LaunchCard): string | undefined {
  const launch = readLaunch(card);
  if (launch) {
    return launch.ownSession ? undefined : launch.childKey;
  }
  const call = unwrapToolCallForDisplay(card);
  const args = asRecord(call.args);
  const tool = call.name.trim().toLowerCase();
  const key =
    tool === "sessions_send" || tool === "sessions_history"
      ? text(args?.sessionKey)
      : tool === "subagents" && (args?.action === "steer" || args?.action === "kill")
        ? text(args?.target)
        : undefined;
  // Steer and stop also take labels, run ids and list indexes; those already read as names.
  return key?.includes(":") ? key : undefined;
}

/**
 * What a call that addresses a session by key is about: the roster names the
 * session, else the call's own label. The key is routing, never a name, so an
 * unresolved session leaves `name` empty and the caller keeps the action.
 */
export function addressedSession(
  card: LaunchCard,
  rows: readonly GatewaySessionRow[] | undefined,
): { name?: string } | undefined {
  const key = readAddressedSessionKey(card);
  if (!key) {
    return undefined;
  }
  const row = rows?.find((candidate) => areUiSessionKeysEquivalent(candidate.key, key));
  return {
    name: row
      ? resolveSessionDisplayName(row.key, row)
      : text(asRecord(unwrapToolCallForDisplay(card).args)?.label),
  };
}

export function isSubagentsPanelSession(row: GatewaySessionRow): boolean {
  return row.classification === "subagent" || isSubagentSessionKey(row.key);
}

/** A subagent that handed off to its own subagents is still at work. */
export function isUnfinishedSubagent(row: GatewaySessionRow): boolean {
  return isSessionRunStateActive(row) || row.hasActiveSubagentRun === true;
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

export function endedWithoutFinishing(row: GatewaySessionRow): "failed" | "stopped" | undefined {
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
) {
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
    // Present only when the roster holds this session.
    session: {
      key: row.key,
      // Whether the Subagents panel lists it.
      listed: isSubagentsPanelSession(row),
      running,
      // Runtime is shown only once the session finishes.
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
