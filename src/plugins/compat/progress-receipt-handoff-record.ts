import type { PluginCompatRecord } from "./types.js";

export const PROGRESS_RECEIPT_HANDOFF_COMPAT_RECORD = {
  code: "reply-dispatch-progress-receipt-handoff",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-09-19",
  deprecated: "2026-10-06",
  warningStarts: "2026-10-06",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Adapt editable progress cards through ReplyDispatchRuntimeInfo.adoptProgressDraft. The released receipt-based adoptProgressContinuation type is retained until the next Plugin SDK major and explicit breaking-release approval; the host never offers it, so adapters keep ordinary waiting-reply delivery.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#progress-card-handoff",
  surfaces: [
    "openclaw/plugin-sdk/reply-runtime.ReplyDispatchRuntimeInfo.adoptProgressContinuation",
  ],
  diagnostics: [
    "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
  ],
  tests: [
    "src/plugin-sdk/shipped-channel-compat.test.ts",
    "src/auto-reply/reply/dispatch-from-config.continuation-settlement.test.ts",
  ],
} as const satisfies PluginCompatRecord;
