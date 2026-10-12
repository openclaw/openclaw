import type { PluginCompatRecord } from "./types.js";

export const MENTION_INBOX_COMPAT_RECORD = {
  code: "mention-inbox-sync-persistence",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-03",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await mentionInbox.listAsync(client, publish), mentionInbox.dismissAsync(client, ids, publish), mentionInbox.recordCommittedInputAsync(input), and mentionInbox.invalidateAsync(sessionKey). Publish list/dismiss responses synchronously inside the supplied callback. Deprecated synchronous signatures remain until the next Plugin SDK major; list/dismiss return UNAVAILABLE and record/invalidate throw migration-directed errors without scheduling work.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations",
  surfaces: [
    "GatewayRequestHandlerOptions.context.mentionInbox.list",
    "GatewayRequestHandlerOptions.context.mentionInbox.dismiss",
    "GatewayRequestHandlerOptions.context.mentionInbox.recordCommittedInput",
    "GatewayRequestHandlerOptions.context.mentionInbox.invalidate",
    "getPluginRuntimeGatewayRequestScope().context.mentionInbox",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations, explicit migration-directed rejection, and one DEP_SESSION_PERSISTENCE warning per plugin and capability family per process; unscoped callers share one SDK-level family warning",
  ],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/plugins/compat/mention-inbox-deprecation.test.ts",
    "src/plugin-sdk/gateway-mention-inbox-compat.test.ts",
    "src/gateway/mention-inbox.test.ts",
    "src/gateway/mention-inbox.compat.test.ts",
  ],
  releaseNote:
    "Mention Inbox reads, dismissals, recording, and invalidation expose awaited worker-backed methods. Synchronous plugin persistence is retired: list/dismiss return UNAVAILABLE and record/invalidate throw with awaited migration guidance. Their TypeScript signatures remain deprecated until the next Plugin SDK major; stored data, retention, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
