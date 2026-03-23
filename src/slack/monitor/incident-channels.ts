// Keep the human-readable Slack slug next to each stable production channel id
// so review comments and operator docs can refer to the same registry.
export const SRE_INCIDENT_CHANNELS = [
  { id: "C07G53ZCV5K", name: "#bug-report" },
  { id: "C0A3T6VVCPQ", name: "#platform-monitoring" },
  { id: "C09EQ94AN1L", name: "#staging-infra-monitoring" },
  { id: "C08BZRS6W12", name: "#public-api-monitoring" },
] as const;

export const SRE_INCIDENT_CHANNEL_IDS = new Set<string>(
  SRE_INCIDENT_CHANNELS.map((channel) => channel.id),
);

export function isSreIncidentChannelId(channelId?: string): boolean {
  return !!channelId && SRE_INCIDENT_CHANNEL_IDS.has(channelId);
}
