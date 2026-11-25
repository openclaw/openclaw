// These are runtime error-message contracts, not replay authority. Keep detection
// browser-safe so recorded failures and fresh Gateway projections share their copy.
const STARTUP_FAILURES = [
  {
    // codex-rs thread_processor.rs: read_thread_view has neither live nor persisted state.
    pattern: /^thread not loaded: \S+(?:$|\s*(?:\||: code=|\n))/u,
    diagnostic: "thread not loaded",
    newConversation: true,
    title: "OpenClaw couldn't find the saved conversation data needed to continue.",
    channelRecovery: "Send /new to start a new conversation, then send your request again.",
    recovery: "Start a new conversation and send your request again.",
  },
  {
    // allocation.ts names the lease; the state-lease owner supplies scope/key and outcome.
    pattern:
      /^managed worktree allocation lease core:managed-worktrees:(?:create|mutation)\/\S+ (?:was lost|expired)(?:$|\s*(?:\(lease loss:|; retry the operation|\||: code=|\n))/u,
    diagnostic: "managed worktree allocation lease was lost",
    newConversation: false,
    title: "Couldn't finish preparing the code workspace.",
    channelRecovery: "Send your request again to retry workspace setup.",
    recovery: "Send your request again to retry workspace setup.",
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
  for (const {
    pattern,
    title,
    recovery,
    channelRecovery,
    diagnostic,
    newConversation,
  } of STARTUP_FAILURES) {
    const message = `${title} ${recovery}`;
    const channelMessage = `${title} ${channelRecovery}`;
    // Fresh errors and already normalized persisted summaries render identically.
    if (normalized === message || normalized.startsWith(`${message}\n\n`)) {
      return {
        title,
        recovery,
        message,
        channelMessage,
        diagnostic,
        newConversation,
        display: error.trim(),
      };
    }
    if (normalized === diagnostic || pattern.test(normalized)) {
      return {
        title,
        recovery,
        message,
        channelMessage,
        diagnostic,
        newConversation,
        display: `${message}\n\n${error.trim()}`,
      };
    }
  }
  return undefined;
}
