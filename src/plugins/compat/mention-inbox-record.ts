import type { PluginCompatRecord } from "./types.js";

export const MENTION_INBOX_COMPAT_RECORD = {
  code: "mention-inbox-sync-persistence",
  status: "removed",
  owner: "sdk",
  introduced: "2026-10-03",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  replacement:
    "Await mentionInbox.listAsync(client, publish), mentionInbox.dismissAsync(client, ids, publish), mentionInbox.recordCommittedInputAsync(input), and mentionInbox.invalidateAsync(sessionKey). Publish list/dismiss responses synchronously inside the supplied callback.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations",
  surfaces: [
    "GatewayRequestHandlerOptions.context.mentionInbox.list",
    "GatewayRequestHandlerOptions.context.mentionInbox.dismiss",
    "GatewayRequestHandlerOptions.context.mentionInbox.recordCommittedInput",
    "GatewayRequestHandlerOptions.context.mentionInbox.invalidate",
  ],
  diagnostics: ["plugin compatibility registry and migration guide"],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/gateway/mention-inbox.worker.test.ts",
    "src/gateway/mention-inbox.test.ts",
  ],
  releaseNote:
    "Removes synchronous Mention Inbox listing, dismissal, recording, and invalidation first deprecated in stable v2026.10.1. Await worker completion before dependent publication. The newer validateRecipients method remains deprecated; stored data, retention, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;

export const MENTION_INBOX_VALIDATION_COMPAT_RECORD = {
  code: "mention-inbox-sync-recipient-validation",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-12",
  deprecated: "2026-10-12",
  warningStarts: "2026-10-12",
  removalGate: "after-stable-deprecation",
  replacement: "Await mentionInbox.validateRecipientsAsync with the existing arguments.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations",
  surfaces: ["GatewayRequestHandlerOptions.context.mentionInbox.validateRecipients"],
  diagnostics: [
    "TypeScript @deprecated annotation and one shared DEP_SESSION_PERSISTENCE warning per plugin and mention-inbox family per process",
  ],
  tests: [
    "src/plugins/compat/mention-inbox-deprecation.test.ts",
    "src/gateway/mention-inbox.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Recipient validation has an awaited worker replacement. The synchronous contract remains supported because its deprecation has not shipped in stable v2026.10.2 or earlier; its first stable deprecation release is pending.",
} as const satisfies PluginCompatRecord;
