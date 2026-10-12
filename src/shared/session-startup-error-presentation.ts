// These are runtime error-message contracts, not replay authority. Keep detection
// browser-safe so recorded failures and fresh Gateway projections share their copy.
const STARTUP_FAILURES = [
  {
    // codex-rs thread_processor.rs: read_thread_view has neither live nor persisted state.
    pattern: /^thread not loaded: \S+(?:$|\s*(?:\||: code=|\n))/u,
    title: "Conversation context is unavailable.",
    recovery:
      "Refresh and try again. If it still fails, start a new conversation with the context you need.",
  },
  {
    // allocation.ts names the lease; the state-lease owner supplies scope/key and outcome.
    pattern:
      /^managed worktree allocation lease core:managed-worktrees:(?:create|mutation)\/\S+ (?:was lost|expired)(?:$|\s*(?:\||: code=|\n))/u,
    title: "Workspace preparation was interrupted.",
    recovery:
      "Refresh to check its status before trying again. You can keep using this conversation.",
  },
];

/** Curated presentation only; never use this result to authorize retries or state repair. */
export function resolveSessionStartupErrorPresentation(error: string) {
  const normalized = error
    .trim()
    .replace(
      /^(?:(?:Error|CodexAppServerRpcError|OpenClawStateLeaseError):\s*|Your request couldn't be completed:\s*|This turn did not run:\s*)+/u,
      "",
    );
  for (const { pattern, title, recovery } of STARTUP_FAILURES) {
    const message = `${title} ${recovery}`;
    // Fresh errors and already normalized persisted summaries render identically.
    if (normalized === message || normalized.startsWith(`${message}\n\n`)) {
      return { title, recovery, message, display: error.trim() };
    }
    if (pattern.test(normalized)) {
      return { title, recovery, message, display: `${message}\n\n${error.trim()}` };
    }
  }
  return undefined;
}
