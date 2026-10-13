import type { PluginCompatRecord } from "./types.js";

export const REPLY_TOOL_AUTHORITY_COMPAT_RECORD = {
  code: "reply-tool-authority-sync-preparation",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-04",
  deprecated: "2026-10-04",
  warningStarts: "2026-10-04",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await the Async reply-operation, fingerprint, and V2 queue companions. Question dispatchers await authority.assertCurrentAsync after transport preparation and assert current authority immediately before I/O. Released synchronous contracts remain until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-reply-tool-authority",
  surfaces: [
    "EmbeddedRunAttemptParams.replyOperation",
    "EmbeddedRunAttemptParamsV2.replyOperation",
    "AgentHarnessAttemptParams.replyOperation",
    "AgentHarnessAttemptParamsV2.replyOperation",
    "ReplyToolAuthoritySnapshot.fingerprint and project",
    "ReplyBackendMessageInjectionV2.queueMessage, claimPendingUserInputAnswer, and cancelPendingUserInput",
    "AgentQuestionDispatcher.authority.assertCurrent",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
  ],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/plugin-sdk/reply-tool-authority-compat.test.ts",
  ],
  releaseNote:
    "Reply tool authority preparation gains awaited session-reader paths while retaining released synchronous snapshot, operation, and dispatcher contracts. Legacy external V2 dispatchers retain fresh native authority checks; schema, retention, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
