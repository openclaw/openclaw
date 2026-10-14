// Message-tool config field labels, split out of schema.labels.ts to keep that
// grandfathered file within its line cap. Spread into FIELD_LABELS at the same
// position the inline block occupied.
export const MESSAGE_TOOL_FIELD_LABELS: Record<string, string> = {
  "tools.message.crossContext.allowWithinProvider": "Allow Cross-Context (Same Provider)",
  "tools.message.crossContext.allowAcrossProviders": "Allow Cross-Context (Across Providers)",
  "tools.message.crossContext.marker.enabled": "Cross-Context Marker",
  "tools.message.crossContext.marker.prefix": "Cross-Context Marker Prefix",
  "tools.message.crossContext.marker.suffix": "Cross-Context Marker Suffix",
  "tools.message.broadcast.enabled": "Enable Message Broadcast",
  "tools.message.maxMessagesPerTurnPerTarget": "Max Messages Per Turn Per Target",
  "tools.message.turnSendNudge": "Turn Send Nudge",
  "tools.message.actions.allow": "Message Action Allowlist",
};
