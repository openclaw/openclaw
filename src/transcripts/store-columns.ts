import { readJsonObjectMembers } from "../infra/json-object-members.js";

function stringFields(json: string | null): Map<string, string> {
  try {
    return json === null ? new Map() : readJsonObjectMembers(json);
  } catch {
    return new Map();
  }
}

function text(fields: Map<string, string>, key: string): string | null {
  const raw = fields.get(key);
  const value: unknown = raw?.startsWith('"') ? JSON.parse(raw) : null;
  return typeof value === "string" ? value : null;
}

export function deriveMeetingTranscriptSessionColumns(
  sourceJson: string,
  metadataJson: string | null,
) {
  const source = stringFields(sourceJson);
  const metadata = stringFields(metadataJson);
  return {
    source_account_id: text(source, "accountId"),
    source_guild_id: text(source, "guildId"),
    source_channel_id: text(source, "channelId"),
    source_meeting_url: text(source, "meetingUrl"),
    source_thread_ts: text(source, "threadTs"),
    source_file_id: text(source, "fileId"),
    metadata_agent_id: text(metadata, "agentId"),
  };
}

export function deriveMeetingTranscriptSummaryColumns(summaryJson: string | null) {
  const summary = stringFields(summaryJson);
  return { overview: text(summary, "overview") };
}
