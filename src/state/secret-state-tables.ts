/** Redaction policy surface: Git snapshots may omit these credential-bearing tables. */
export const STATE_SECRET_TABLE_NAMES = [
  "audit_identity_keys",
  "apns_registrations",
  "channel_ingress_events",
  "channel_pairing_requests",
  "clawhub_promotion_claims",
  "config_revision_keys",
  "device_auth_tokens",
  "device_bootstrap_tokens",
  "device_identities",
  "device_pairing_join_codes",
  "device_pairing_paired",
  "gateway_origin_device_tokens",
  "mcp_oauth_pending_authorizations",
  "mcp_oauth_stores",
  "native_hook_relay_bridges",
  "secret_store_entries",
  // Delivery receipts cannot survive omission of their subscription parent.
  "web_push_approval_deliveries",
  "web_push_subscriptions",
  "worker_environment_credentials",
] as const;

/** Secret-redacted Git backups must never carry machine-state values under these prefixes. */
export const STATE_SECRET_CONFIG_STATE_KEY_PREFIXES = [
  "authProfiles.",
  "nodeHost.",
  "webPush.vapidKeys",
] as const;

/** Omit bundled plugin credentials without discarding unrelated durable plugin state. */
export const STATE_SECRET_PLUGIN_SCOPES: readonly {
  pluginId: string;
  namespace: RegExp;
  entryKey?: string;
  jsonFields?: readonly string[];
}[] = [
  { pluginId: "discord", namespace: /^activities-(?:sessions|doc-tokens)$/u },
  { pluginId: "discord", namespace: /^thread-bindings$/u, jsonFields: ["webhookToken"] },
  { pluginId: "google-meet", namespace: /^oauth-credential$/u },
  { pluginId: "matrix", namespace: /^(?:credentials|recovery-key|idb-snapshot)$/u },
  { pluginId: "mcp-events", namespace: /^subscriptions-v1$/u },
  { pluginId: "mcp-relay", namespace: /^mcp-relay-authority$/u, entryKey: "identity" },
  { pluginId: "msteams", namespace: /^(?:delegated-token|sso-tokens)(?:-[a-f0-9]{64})?$/u },
  { pluginId: "reef", namespace: /^identity$/u },
  { pluginId: "reef", namespace: /^registration$/u, entryKey: "setup-session" },
  { pluginId: "sms", namespace: /^hosted-outbound-media-[a-f0-9]{16}$/u },
  { pluginId: "synology-chat", namespace: /^hosted-outbound-media-[a-f0-9]{16}$/u },
  { pluginId: "twitch", namespace: /^oauth-/u },
  { pluginId: "x", namespace: /^x\.oauth$/u },
  { pluginId: "zalo", namespace: /^hosted-outbound-media$/u },
  { pluginId: "zalouser", namespace: /^credentials$/u },
];

/** Redaction policy surface for credential-bearing per-agent database tables. */
export const AGENT_SECRET_TABLE_NAMES = [
  "auth_profile_state",
  "auth_profile_store",
  "session_suggestions",
] as const;
