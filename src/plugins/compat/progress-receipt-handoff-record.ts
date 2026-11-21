import type { PluginCompatRecord } from "./types.js";

export const PROGRESS_RECEIPT_HANDOFF_COMPAT_RECORD = {
  code: "reply-dispatch-progress-receipt-handoff",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-06",
  warningStarts: "2026-10-06",
  removalGate: "stable-deprecation-period",
  replacement:
    "Adapt editable progress cards through ReplyDispatchRuntimeInfo.adoptProgressDraft. The released receipt-based adoptProgressContinuation type is retained until an announced later ordinary stable release and explicit maintainer approval; the host never offers it, so adapters keep ordinary waiting-reply delivery.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#progress-card-handoff",
  surfaces: [
    "openclaw/plugin-sdk/reply-runtime.ReplyDispatchRuntimeInfo.adoptProgressContinuation",
  ],
  diagnostics: [
    "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
  ],
} as const satisfies PluginCompatRecord;
