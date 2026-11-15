// What each part of /settings/mcp edits from the shared `mcp` config schema,
// with no rendering imports.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigUiHints } from "../../api/types.ts";
import { t } from "../../lib/reactive/i18n.ts";

// Stable schema identity keeps the config view's analysis cached across renders.
const mcpSettingsSchemas = new WeakMap<Record<string, unknown>, unknown>();

/** The `mcp` section without its servers, which the server list owns. */
export function mcpSettingsSchema(schema: unknown): unknown {
  const root = asConfigRecord(schema);
  const mcpSchema = asConfigRecord(asConfigRecord(root?.properties)?.mcp);
  const mcpProperties = asConfigRecord(mcpSchema?.properties);
  if (!root || !mcpSchema || !mcpProperties) {
    return schema;
  }
  const hit = mcpSettingsSchemas.get(root);
  if (hit !== undefined) {
    return hit;
  }
  const { servers: _servers, apps, ...retained } = mcpProperties;
  // The Apps switch is a plain row; only its sandbox details stay in the schema form.
  const appsSchema = asConfigRecord(apps);
  const appsProperties = asConfigRecord(appsSchema?.properties);
  const { enabled: _enabled, ...appsRetained } = appsProperties ?? {};
  const narrowed = {
    ...root,
    properties: {
      mcp: {
        ...mcpSchema,
        properties: {
          ...retained,
          ...(appsSchema ? { apps: { ...appsSchema, properties: appsRetained } } : {}),
        },
      },
    },
  };
  mcpSettingsSchemas.set(root, narrowed);
  return narrowed;
}

function serverSchemaOf(schema: unknown): Record<string, unknown> | null {
  const mcpProperties = asConfigRecord(
    asConfigRecord(asConfigRecord(asConfigRecord(schema)?.properties)?.mcp)?.properties,
  );
  return asConfigRecord(asConfigRecord(mcpProperties?.servers)?.additionalProperties);
}

/** Every field the server schema names; anything else on a server is a custom entry. */
export function mcpServerFieldNames(schema: unknown): string[] {
  return Object.keys(asConfigRecord(serverSchemaOf(schema)?.properties) ?? {});
}

const STDIO_FIELDS = ["cwd", "env"];
const HTTP_FIELDS = ["url", "auth", "headers"];
// The row's switch and the panel's own connection controls edit these.
const PANEL_OWNED_FIELDS = new Set(["enabled", "transport", "command", "args"]);
const HTTP_ONLY_FIELDS = new Set([...HTTP_FIELDS, "oauth", "sslVerify", "clientCert", "clientKey"]);
const STDIO_ONLY_FIELDS = new Set(STDIO_FIELDS);

// `auth` is the literal "oauth" or nothing, so it reads as a switch rather than a text field.
const OAUTH_SWITCH_SCHEMA = { type: "boolean" };

/**
 * One server's fields, connection first. Fields of the other connection kind stay
 * hidden unless this server already sets them, so nothing saved becomes unreachable.
 */
export function mcpServerSchema(
  schema: unknown,
  server: Record<string, unknown> | null,
  stdio: boolean,
): Record<string, unknown> | null {
  const serverSchema = serverSchemaOf(schema);
  const properties = asConfigRecord(serverSchema?.properties);
  if (!serverSchema || !properties) {
    return null;
  }
  const hidden = stdio ? HTTP_ONLY_FIELDS : STDIO_ONLY_FIELDS;
  const first = stdio ? STDIO_FIELDS : HTTP_FIELDS;
  const keys = [...first, ...Object.keys(properties).filter((key) => !first.includes(key))];
  return {
    ...serverSchema,
    properties: Object.fromEntries(
      keys.flatMap((key) =>
        key in properties &&
        !PANEL_OWNED_FIELDS.has(key) &&
        (!hidden.has(key) || server?.[key] !== undefined)
          ? [[key, key === "auth" ? OAUTH_SWITCH_SCHEMA : properties[key]]]
          : [],
      ),
    ),
  };
}

const SERVER_FIELD_LABELS: Record<string, () => string> = {
  cwd: () => t("mcpServers.fieldCwd"),
  env: () => t("mcpServers.fieldEnv"),
  url: () => t("mcpServers.fieldUrl"),
  auth: () => t("mcpServers.fieldOauth"),
  headers: () => t("mcpServers.fieldHeaders"),
};

const SERVER_FIELD_ORDER = [...STDIO_FIELDS, ...HTTP_FIELDS];

// Inside one server's panel, the "MCP" in every label only repeats where you are.
const stripMcpPrefix = (label: string) => label.replace(/^MCP (Server )?/u, "");

/** Per-server labels and tiers: connection details are common, secrets included. */
export function mcpServerHints(hints: ConfigUiHints): ConfigUiHints {
  const prefix = "mcp.servers.*.";
  const next: ConfigUiHints = { ...hints };
  for (const [path, hint] of Object.entries(hints)) {
    if (path.startsWith(prefix) && hint.label) {
      next[path] = { ...hint, label: stripMcpPrefix(hint.label) };
    }
  }
  for (const [field, label] of Object.entries(SERVER_FIELD_LABELS)) {
    const path = `${prefix}${field}`;
    const order = SERVER_FIELD_ORDER.indexOf(field) - SERVER_FIELD_ORDER.length;
    next[path] = { ...next[path], label: label(), advanced: false, order };
  }
  for (const field of ["env.*", "headers.*"]) {
    const path = `${prefix}${field}`;
    next[path] = { ...next[path], advanced: false };
  }
  const authProfile = `${prefix}oauth.authProfileId`;
  next[authProfile] = { ...next[authProfile], advanced: true };
  return next;
}

export function readMcpAppsEnabled(config: Record<string, unknown> | null | undefined): boolean {
  return asConfigRecord(asConfigRecord(config?.mcp)?.apps)?.enabled === true;
}
