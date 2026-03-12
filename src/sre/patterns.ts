export const DATA_INCIDENT_RE =
  /\b(apy|graphql|internal_server_error|traceId|sentryEventId|vaultv2|wrong values?|stale values?|realtime state)\b/i;

export const EXACT_ARTIFACT_RE =
  /(query\s+[A-Za-z_]\w*|\bvaultV2ByAddress\b|\bvaultByAddress\b|\bsentryEventId\b|\btraceId\b|\b0x[a-fA-F0-9]{8,}\b)/i;

export function extractResolverFamily(
  text: string,
): "vaultV2ByAddress" | "vaultByAddress" | undefined {
  if (/\bvaultV2ByAddress\b/.test(text)) {
    return "vaultV2ByAddress";
  }
  if (/\bvaultByAddress\b/.test(text)) {
    return "vaultByAddress";
  }
  return undefined;
}

export function extractInlineJsonTextValue(line: string): string | undefined {
  const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, '"');
  }
}
