import type { PreparedSessionSourceAssertion } from "./session-source-authority.js";

/** Host checks never query SQLite; prepared sources retain their own predicate owner. */
export type SessionEntryPatchAuthority =
  | { kind: "host"; assertCurrent(): void }
  | { kind: "source"; source: PreparedSessionSourceAssertion };

export function assertSessionEntryPatchAuthority(
  authority: SessionEntryPatchAuthority | undefined,
): void {
  if (authority?.kind === "source" && typeof authority.source.prepareSessionSource !== "function") {
    throw new Error(
      "Session entry source authority requires a prepared source capability; use kind: host for SQLite-free checks or the deprecated patchSessionEntry API for legacy callbacks",
    );
  }
}
