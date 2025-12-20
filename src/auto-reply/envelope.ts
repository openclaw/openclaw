export type AgentEnvelopeParams = {
  surface: string;
  from?: string;
  timestamp?: number | Date;
  host?: string;
  ip?: string;
  body: string;
};

function formatTimestamp(ts?: number | Date): string | undefined {
  if (!ts) return undefined;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;

  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");

  // getTimezoneOffset() is minutes *behind* UTC. Flip sign to get ISO offset.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffsetMinutes = Math.abs(offsetMinutes);
  const offsetH = String(Math.floor(absOffsetMinutes / 60)).padStart(2, "0");
  const offsetM = String(absOffsetMinutes % 60).padStart(2, "0");

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzSuffix = tz ? `{${tz}}` : "";

  // Compact ISO-like *local* timestamp with minutes precision.
  // Example: 2025-01-02T03:04-08:00{America/Los_Angeles}
  return `${yyyy}-${mm}-${dd}T${hh}:${min}${sign}${offsetH}:${offsetM}${tzSuffix}`;
}

export function formatAgentEnvelope(params: AgentEnvelopeParams): string {
  const surface = params.surface?.trim() || "Surface";
  const parts: string[] = [surface];
  if (params.from?.trim()) parts.push(params.from.trim());
  if (params.host?.trim()) parts.push(params.host.trim());
  if (params.ip?.trim()) parts.push(params.ip.trim());
  const ts = formatTimestamp(params.timestamp);
  if (ts) parts.push(ts);
  const header = `[${parts.join(" ")}]`;
  return `${header} ${params.body}`;
}
