export function normalizeMessageProvider(
  raw?: string | null,
): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "imsg") return "imessage";
  if (normalized === "teams") return "msteams";
  return normalized;
}

export const DELIVERABLE_MESSAGE_PROVIDERS = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "msteams",
] as const;

export type DeliverableMessageProvider =
  (typeof DELIVERABLE_MESSAGE_PROVIDERS)[number];

export const INTERNAL_MESSAGE_PROVIDER = "webchat" as const;
export type InternalMessageProvider = typeof INTERNAL_MESSAGE_PROVIDER;

export type GatewayMessageProvider =
  | DeliverableMessageProvider
  | InternalMessageProvider;

export const GATEWAY_MESSAGE_PROVIDERS = [
  ...DELIVERABLE_MESSAGE_PROVIDERS,
  "webchat",
] as const;

export const GATEWAY_AGENT_PROVIDER_ALIASES = ["imsg", "teams"] as const;
export type GatewayAgentProviderAlias =
  (typeof GATEWAY_AGENT_PROVIDER_ALIASES)[number];

export type GatewayAgentProviderHint =
  | GatewayMessageProvider
  | "last"
  | GatewayAgentProviderAlias;

export const GATEWAY_AGENT_PROVIDER_VALUES = [
  ...GATEWAY_MESSAGE_PROVIDERS,
  "last",
  ...GATEWAY_AGENT_PROVIDER_ALIASES,
] as const;

export function isGatewayMessageProvider(
  value: string,
): value is GatewayMessageProvider {
  return (GATEWAY_MESSAGE_PROVIDERS as readonly string[]).includes(value);
}

export function isDeliverableMessageProvider(
  value: string,
): value is DeliverableMessageProvider {
  return (DELIVERABLE_MESSAGE_PROVIDERS as readonly string[]).includes(value);
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
