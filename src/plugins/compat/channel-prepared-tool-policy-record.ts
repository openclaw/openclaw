import type { PluginCompatRecord } from "./types.js";

export const CHANNEL_PREPARED_TOOL_POLICY_COMPAT_RECORD = {
  code: "channel-prepared-tool-policy",
  status: "deprecated",
  owner: "channel",
  introduced: "2026-08-09",
  deprecated: "2026-10-12",
  warningStarts: "2026-10-12",
  removalGate: "stable-deprecation-period",
  replacement:
    "Resolve current configuration through security.resolveDirectToolPolicy or groups.resolveToolPolicy using authenticated requester and conversation facts. The legacy snapshot remains execution-local to the original external request, including its queued turn; it is never requester provenance for new delegation.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#channel-prepared-tool-policy",
  surfaces: [
    "BuildChannelInboundEventContextParams.access.toolPolicy",
    "MsgContext.ConversationToolPolicy",
  ],
  diagnostics: ["DEP_CHANNEL_PREPARED_TOOL_POLICY warns once on legacy policy use"],
  tests: [
    "src/channels/inbound-event/legacy-tool-policy.test.ts",
    "src/agents/conversation-capability-profile.test.ts",
    "src/auto-reply/reply/agent-runner-utils.test.ts",
    "extensions/telegram/src/security.test.ts",
  ],
  releaseNote:
    "Channel tool policy resolves from current configuration at each new admission. External prepared-policy fields retain their original-request snapshot contract until a later stable release after an announced deprecation window and explicit maintainer approval. No removal date is set.",
} as const satisfies PluginCompatRecord;
