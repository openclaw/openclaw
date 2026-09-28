import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadMergedBundleMcpConfig } from "../agents/bundle-mcp-config.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { scanEnvTemplateTokens } from "../config/env-substitution.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import { buildConfigSchemaCore } from "../config/schema.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure } from "./failure-output.js";

type LoadedMcpConfig = Extract<Awaited<ReturnType<typeof listConfiguredMcpServers>>, { ok: true }>;

type EffectiveLoadedMcpConfig = LoadedMcpConfig & {
  workspaceDir: string;
  diagnostics: ReturnType<typeof loadMergedBundleMcpConfig>["diagnostics"];
};

export function failMcpCli(message: string, json?: boolean): never {
  if (json) {
    defaultRuntime.writeJson(formatCliJsonFailure(message));
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(1);
  throw new Error(message);
}

export async function loadMcpConfig(opts?: { json?: boolean }) {
  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    failMcpCli(loaded.error, opts?.json);
  }
  return loaded;
}

export function failUnknownMcpServer(
  name: string | undefined,
  configPath: string,
  opts?: { json?: boolean },
): never {
  failMcpCli(
    `No MCP server named "${name}" in ${configPath}. Run ${formatCliCommand("openclaw mcp list")} to see available servers.`,
    opts?.json,
  );
}

export function requireMcpServer(loaded: LoadedMcpConfig, name: string, opts?: { json?: boolean }) {
  const server = loaded.mcpServers[name];
  if (!server) {
    failUnknownMcpServer(name, loaded.path, opts);
  }
  return server;
}

export function selectMcpServers(
  loaded: LoadedMcpConfig,
  name: string | undefined,
  opts?: { json?: boolean },
) {
  return name ? { [name]: requireMcpServer(loaded, name, opts) } : loaded.mcpServers;
}

/** Read enabled plugin MCP declarations together with config-owned overrides. */
export async function loadEffectiveMcpConfig(opts?: {
  json?: boolean;
  inspectNativeHeaderEnvRefs?: boolean;
}): Promise<EffectiveLoadedMcpConfig> {
  const loaded = await loadMcpConfig(opts);
  const agentId = resolveDefaultAgentId(loaded.config);
  const workspaceDir = resolveAgentWorkspaceDir(loaded.config, agentId);
  const merged = loadMergedBundleMcpConfig({
    workspaceDir,
    cfg: loaded.config,
    inspectNativeHeaderEnvRefs: opts?.inspectNativeHeaderEnvRefs,
  });
  const explicitlyDisabled = Object.fromEntries(
    Object.entries(loaded.mcpServers).filter(([, server]) => server.enabled === false),
  );
  const effective = {
    ...loaded,
    // Disabled config entries remain visible, while disabled plugin entries stay excluded.
    mcpServers: { ...merged.config.mcpServers, ...explicitlyDisabled },
    diagnostics: merged.diagnostics,
    workspaceDir,
  };
  for (const diagnostic of effective.diagnostics) {
    defaultRuntime.error(`MCP plugin "${diagnostic.pluginId}": ${diagnostic.message}`);
  }
  return effective;
}

export function redactMcpServersForCli(servers: Record<string, Record<string, unknown>>) {
  const argvRedacted = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")
        ? { ...server, args: redactSensitiveArgv(server.args, REDACTED_SENTINEL) }
        : server,
    ]),
  );
  const redactedRoot = redactConfigObject(
    { mcp: { servers: argvRedacted } },
    buildConfigSchemaCore().uiHints,
  );
  return redactedRoot.mcp?.servers ?? {};
}

/**
 * Returns true when a sensitive value contains literal credential material. Environment
 * references may be combined with an auth scheme or `user:password` delimiter, but any other
 * static fragment remains a literal credential. Escaped references and nonempty fallbacks
 * are literals under the shared config substitution grammar.
 */
export function hasLiteralSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  const tokens = scanEnvTemplateTokens(value);
  if (
    tokens.length === 0 ||
    tokens.some(
      (token) =>
        token.kind === "escaped" ||
        (token.defaultValue !== undefined && token.defaultValue.length > 0),
    )
  ) {
    return true;
  }

  const literalFragments: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const placeholder =
      token.defaultValue === undefined
        ? `\${${token.name}}`
        : `\${${token.name}:-${token.defaultValue}}`;
    const start = value.indexOf(placeholder, cursor);
    if (start === -1) {
      // If the shared scanner and the source cannot be reconciled, fail closed.
      return true;
    }
    literalFragments.push(value.slice(cursor, start));
    cursor = start + placeholder.length;
  }
  literalFragments.push(value.slice(cursor));

  return literalFragments.some((fragment, index) => {
    const trimmed = fragment.trim();
    if (!trimmed || (trimmed === ":" && index > 0 && index < tokens.length)) {
      return false;
    }
    return index !== 0 || !isAuthSchemePrefix(fragment);
  });
}

function isAuthSchemePrefix(fragment: string): boolean {
  const leadingTrimmed = fragment.trimStart();
  return ["bearer", "basic"].some((scheme) => {
    const separator = leadingTrimmed.slice(scheme.length);
    return (
      leadingTrimmed.slice(0, scheme.length).toLowerCase() === scheme &&
      separator.length > 0 &&
      separator.trim().length === 0
    );
  });
}

export async function assertMcpOAuthSourceCurrent(params: {
  name: string;
  server: Record<string, unknown>;
  identity: ReturnType<typeof operatorMcpOAuthIdentity>;
}): Promise<void> {
  const latest = await loadEffectiveMcpConfig();
  const current = latest.mcpServers[params.name];
  const resolved = current ? resolveMcpTransportConfig(params.name, current) : undefined;
  const currentIdentity =
    current?.auth === "oauth" && resolved?.kind === "http"
      ? operatorMcpOAuthIdentity(params.name, resolved.url)
      : undefined;
  if (
    !current ||
    current.enabled === false ||
    !isDeepStrictEqual(current, params.server) ||
    currentIdentity?.storeKey !== params.identity.storeKey
  ) {
    failMcpCli(
      `MCP server "${params.name}" changed during OAuth login. Retry the login with its current configuration.`,
    );
  }
}
