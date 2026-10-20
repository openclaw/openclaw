import type { PluginCompatRecord } from "./types.js";

export const MENTION_INBOX_COMPAT_RECORD = {
  code: "mention-inbox-sync-persistence",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removalGate: "stable-deprecation-period",
  replacement:
    "Await mentionInbox.listAsync(client, publish), mentionInbox.dismissAsync(client, ids, publish), mentionInbox.recordCommittedInputAsync(input), and mentionInbox.invalidateAsync(sessionKey). Publish list/dismiss responses synchronously inside the supplied callback. Deprecated synchronous signatures remain until an announced later ordinary stable release; list/dismiss return UNAVAILABLE, invalidate throws migration guidance, and recordCommittedInput queues the worker operation after commit.",
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
} as const satisfies PluginCompatRecord;
