export function normalizeMessageProvider(
  raw?: string | null,
): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "imsg") return "imessage";
  if (normalized === "teams") return "msteams";
  return normalized;
}

export type GatewayMessageProvider =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage"
  | "msteams"
  | "webchat";

const GATEWAY_MESSAGE_PROVIDERS: GatewayMessageProvider[] = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "msteams",
  "webchat",
];

export function isGatewayMessageProvider(
  value: string,
): value is GatewayMessageProvider {
  return (GATEWAY_MESSAGE_PROVIDERS as string[]).includes(value);
}

export function resolveGatewayMessageProvider(
  raw?: string | null,
): GatewayMessageProvider | undefined {
  const normalized = normalizeMessageProvider(raw);
  if (!normalized) return undefined;
  return isGatewayMessageProvider(normalized) ? normalized : undefined;
}

export function resolveMessageProvider(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return (
    normalizeMessageProvider(primary) ?? normalizeMessageProvider(fallback)
  );
}
