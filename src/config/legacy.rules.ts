import type { LegacyConfigRule } from "./legacy.shared.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasLegacyThreadBindingTtl(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "ttlHours");
}

function hasLegacyThreadBindingTtlInAccounts(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) =>
    hasLegacyThreadBindingTtl(isRecord(entry) ? entry.threadBindings : undefined),
  );
}

function isLegacyGatewayBindHostAlias(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "auto" ||
    normalized === "loopback" ||
    normalized === "lan" ||
    normalized === "tailnet" ||
    normalized === "custom"
  ) {
    return false;
  }
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "*" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export const LEGACY_CONFIG_RULES: LegacyConfigRule[] = [
  {
    path: ["session", "threadBindings"],
    message:
      "session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels", "discord", "threadBindings"],
    message:
      "channels.discord.threadBindings.ttlHours was renamed to channels.discord.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.threadBindings.ttlHours was renamed to channels.discord.accounts.<id>.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtlInAccounts(value),
  },
  {
    path: ["memorySearch"],
    message:
      "top-level memorySearch was moved; use agents.defaults.memorySearch instead (auto-migrated on load).",
  },
  {
    path: ["gateway", "bind"],
    message:
      "gateway.bind host aliases (for example 0.0.0.0/localhost) are legacy; use bind modes (lan/loopback/custom/tailnet/auto) instead (auto-migrated on load).",
    match: (value) => isLegacyGatewayBindHostAlias(value),
    requireSourceLiteral: true,
  },
  {
    path: ["heartbeat"],
    message:
      "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
  },
];
