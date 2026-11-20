import type { InternalSessionEntry } from "./types.js";

/**
 * Private record of the CLI account a session's saved history belongs to. `known` names the
 * first identified account that ran the session; `mixed` means another account ran it later,
 * so the history stays out of every CLI prompt until a new session id starts. Rows from
 * earlier releases may say `unknown`, which can hide an account switch, so it refuses like
 * `mixed`; their retired coverage fields are ignored.
 */
export type CliHistoryBoundary =
  | { version: 1; sessionId: string; state: "unknown" | "mixed" }
  | { version: 1; sessionId: string; state: "known"; authFingerprint: string };

export function isKnownCliHistoryBoundary(
  boundary: CliHistoryBoundary | undefined,
): boundary is Extract<CliHistoryBoundary, { state: "known" }> {
  return (
    boundary?.version === 1 &&
    boundary.state === "known" &&
    typeof boundary.sessionId === "string" &&
    boundary.sessionId.length > 0 &&
    typeof boundary.authFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(boundary.authFingerprint)
  );
}

/**
 * A fork copies the parent's transcript prefix, so it keeps the parent's account record,
 * rebound to the child's session id.
 */
export function forkCliHistoryBoundary(
  parent: InternalSessionEntry | undefined,
  sessionId: string,
): CliHistoryBoundary | undefined {
  const boundary = parent?.cliHistoryBoundary;
  return boundary && boundary.sessionId === parent.sessionId
    ? { ...boundary, sessionId }
    : undefined;
}
