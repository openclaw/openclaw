export function extractExplicitGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts.slice(2).join(":") || undefined;
  }
  if (
    parts.length >= 2 &&
    parts[0]?.toLowerCase() === "whatsapp" &&
    trimmed.toLowerCase().includes("@g.us")
  ) {
    return parts.slice(1).join(":") || undefined;
  }
  if (parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")) {
    return parts.slice(1).join(":") || undefined;
  }
  return undefined;
}
