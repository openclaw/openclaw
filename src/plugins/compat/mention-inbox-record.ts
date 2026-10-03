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
    "Await mentionInbox.listAsync(client, publish) and mentionInbox.dismissAsync(client, ids, publish). Publish responses synchronously inside the supplied callback. Retain synchronous list/dismiss only for shipped third-party contracts until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations",
  surfaces: [
    "GatewayRequestHandlerOptions.context.mentionInbox.list",
    "GatewayRequestHandlerOptions.context.mentionInbox.dismiss",
    "getPluginRuntimeGatewayRequestScope().context.mentionInbox",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and one DEP_SESSION_PERSISTENCE warning per plugin and method per process; unscoped callers warn once per method",
  ],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/plugins/compat/mention-inbox-deprecation.test.ts",
    "src/plugin-sdk/gateway-mention-inbox-compat.test.ts",
    "src/gateway/mention-inbox.test.ts",
  ],
  releaseNote:
    "Mention Inbox reads and dismissals expose awaited worker-backed methods. Synchronous plugin methods retain their existing return values and completion timing until the next Plugin SDK major; stored data, retention, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
