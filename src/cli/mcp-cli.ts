import { Command } from "commander";
import { buildBundleMcpToolsFromCatalog } from "../agents/agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "../agents/mcp-http-fetch.js";
import { clearMcpOAuthCredentials, runMcpOAuthLogin } from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { parseConfigValue } from "../auto-reply/reply/config-value.js";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
  updateConfiguredMcpServer,
  updateConfiguredMcpServerTools,
} from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { serveOpenClawChannelMcp } from "../mcp/channel-server.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { formatCliCommand } from "./command-format.js";
import { resolveGatewayAuthOptions } from "./gateway-secret-options.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

function fail(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
  throw new Error(message);
}

function printJson(value: unknown): void {
  defaultRuntime.writeJson(value);
}

function parseCsvList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseKeyValueEntries(values: readonly string[] | undefined, label: string) {
  const entries: Record<string, string> = {};
  for (const raw of values ?? []) {
    const separatorIndex = raw.indexOf("=");
    if (separatorIndex <= 0) {
      fail(`${label} entries must use KEY=VALUE.`);
    }
    const key = raw.slice(0, separatorIndex).trim();
    const value = raw.slice(separatorIndex + 1);
    if (!key) {
      fail(`${label} entries must use a non-empty key.`);
    }
    entries[key] = value;
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function parsePositiveNumberOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${label} must be a positive number.`);
  }
  return parsed;
}

function parseOAuthConfig(opts: {
  scope?: string;
  redirectUrl?: string;
  clientMetadataUrl?: string;
}): Record<string, string> | undefined {
  const oauth = {
    ...(normalizeStringifiedOptionalString(opts.scope) ? { scope: opts.scope!.trim() } : {}),
    ...(normalizeStringifiedOptionalString(opts.redirectUrl)
      ? { redirectUrl: opts.redirectUrl!.trim() }
      : {}),
    ...(normalizeStringifiedOptionalString(opts.clientMetadataUrl)
      ? { clientMetadataUrl: opts.clientMetadataUrl!.trim() }
      : {}),
  };
  return Object.keys(oauth).length > 0 ? oauth : undefined;
}

async function clearMcpOAuthCredentialsForConfiguredServer(
  name: string,
  server: unknown,
): Promise<void> {
  const resolved = resolveMcpTransportConfig(name, server);
  if (resolved?.kind === "http") {
    await clearMcpOAuthCredentials({ serverName: name, serverUrl: resolved.url });
  }
}

function hasOAuthAuth(server: unknown): boolean {
  return (
    typeof server === "object" && server !== null && "auth" in server && server.auth === "oauth"
  );
}

async function clearStaleMcpOAuthCredentialsForReplacement(params: {
  name: string;
  previous: unknown;
  next: unknown;
}): Promise<void> {
  if (!hasOAuthAuth(params.previous)) {
    return;
  }
  const previousResolved = resolveMcpTransportConfig(params.name, params.previous);
  if (previousResolved?.kind !== "http") {
    return;
  }
  const nextResolved = hasOAuthAuth(params.next)
    ? resolveMcpTransportConfig(params.name, params.next)
    : undefined;
  if (nextResolved?.kind === "http" && nextResolved.url === previousResolved.url) {
    return;
  }
  await clearMcpOAuthCredentials({
    serverName: params.name,
    serverUrl: previousResolved.url,
  });
}

function setOptionalField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

type McpStatusEntry = {
  name: string;
  configured: true;
  enabled: boolean;
  ok: boolean;
  transport?: string;
  launch?: string;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  auth?: unknown;
  toolFilter?: unknown;
  codex?: unknown;
};

function formatMcpProbeResult(
  catalog: Awaited<ReturnType<ReturnType<typeof createSessionMcpRuntime>["getCatalog"]>>,
) {
  const projectedTools = buildBundleMcpToolsFromCatalog({
    catalog,
    createResourceListExecute: () => async () => {
      throw new Error("probe projection cannot execute MCP resources_list");
    },
    createResourceReadExecute: () => async () => {
      throw new Error("probe projection cannot execute MCP resources_read");
    },
    createPromptListExecute: () => async () => {
      throw new Error("probe projection cannot execute MCP prompts_list");
    },
    createPromptGetExecute: () => async () => {
      throw new Error("probe projection cannot execute MCP prompts_get");
    },
  });
  return {
    generatedAt: new Date(catalog.generatedAt).toISOString(),
    servers: Object.fromEntries(
      Object.entries(catalog.servers)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, server]) => [
          name,
          {
            launch: server.launchSummary,
            tools: server.toolCount,
            ...(server.requestTimeoutMs ? { requestTimeoutMs: server.requestTimeoutMs } : {}),
            ...(server.supportsParallelToolCalls
              ? { supportsParallelToolCalls: server.supportsParallelToolCalls }
              : {}),
            ...(server.tools?.filteredCount ? { filteredTools: server.tools.filteredCount } : {}),
            ...(server.resources ? { resources: true } : {}),
            ...(server.prompts ? { prompts: true } : {}),
            ...(server.tools?.listChanged ||
            server.resources?.listChanged ||
            server.prompts?.listChanged
              ? {
                  listChanged: {
                    tools: server.tools?.listChanged === true,
                    resources: server.resources?.listChanged === true,
                    prompts: server.prompts?.listChanged === true,
                  },
                }
              : {}),
          },
        ]),
    ),
    tools: projectedTools.map((tool) => tool.name).toSorted(),
    diagnostics: catalog.diagnostics ?? [],
  };
}

function buildMcpProbeConfig(params: {
  config: OpenClawConfig;
  servers: Record<string, Record<string, unknown>>;
}): OpenClawConfig {
  return {
    ...params.config,
    mcp: {
      ...params.config.mcp,
      servers: params.servers,
    },
  };
}

async function probeMcpServersOrFail(params: {
  config: OpenClawConfig;
  servers: Record<string, Record<string, unknown>>;
  path: string;
}): Promise<ReturnType<typeof formatMcpProbeResult>> {
  const runtime = createSessionMcpRuntime({
    sessionId: "openclaw-cli-mcp-probe",
    workspaceDir: process.cwd(),
    cfg: buildMcpProbeConfig({ config: params.config, servers: params.servers }),
    manifestRegistry: { plugins: [] },
  });
  try {
    const result = formatMcpProbeResult(await runtime.getCatalog());
    if (result.diagnostics.length > 0) {
      const first = result.diagnostics[0];
      fail(`MCP probe failed for "${first.serverName}" in ${params.path}: ${first.message}`);
    }
    for (const name of Object.keys(params.servers)) {
      if (!result.servers[name]) {
        fail(`MCP probe did not connect to "${name}" in ${params.path}.`);
      }
    }
    return result;
  } finally {
    await runtime.dispose();
  }
}

export function registerMcpCli(program: Command) {
  const mcp = program.command("mcp").description("Manage OpenClaw MCP config and channel bridge");

  mcp
    .command("serve")
    .description("Expose OpenClaw channels over MCP stdio")
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--token-file <path>", "Read gateway token from file")
    .option("--password <password>", "Gateway password (if required)")
    .option("--password-file <path>", "Read gateway password from file")
    .option(
      "--claude-channel-mode <mode>",
      "Claude channel notification mode: auto, on, or off",
      "auto",
    )
    .option("-v, --verbose", "Verbose logging to stderr", false)
    .action(async (opts) => {
      try {
        const { gatewayToken, gatewayPassword } = resolveGatewayAuthOptions(opts);
        const claudeChannelMode = normalizeLowercaseStringOrEmpty(
          normalizeStringifiedOptionalString(opts.claudeChannelMode) ?? "auto",
        );
        if (
          claudeChannelMode !== "auto" &&
          claudeChannelMode !== "on" &&
          claudeChannelMode !== "off"
        ) {
          throw new Error('Invalid --claude-channel-mode value. Use "auto", "on", or "off".');
        }
        await serveOpenClawChannelMcp({
          gatewayUrl: opts.url as string | undefined,
          gatewayToken,
          gatewayPassword,
          claudeChannelMode,
          verbose: Boolean(opts.verbose),
        });
      } catch (err) {
        defaultRuntime.error(
          `MCP server failed to start: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw mcp list")} to inspect configured servers.`,
        );
        defaultRuntime.exit(1);
      }
    });

  mcp
    .command("list")
    .description("List configured MCP servers")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      if (opts.json) {
        printJson(loaded.mcpServers);
        return;
      }
      const names = Object.keys(loaded.mcpServers).toSorted();
      if (names.length === 0) {
        defaultRuntime.log(
          `No MCP servers configured in ${loaded.path}. Add one with ${formatCliCommand('openclaw mcp set <name> \'{"command":"uvx","args":["context7-mcp"]}\'')}.`,
        );
        return;
      }
      defaultRuntime.log(`MCP servers (${loaded.path}):`);
      for (const name of names) {
        defaultRuntime.log(`- ${name}`);
      }
    });

  mcp
    .command("show")
    .description("Show one configured MCP server or the full MCP config")
    .argument("[name]", "MCP server name")
    .option("--json", "Print JSON")
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const value = name ? loaded.mcpServers[name] : loaded.mcpServers;
      if (name && !value) {
        fail(
          `No MCP server named "${name}" in ${loaded.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
        );
      }
      if (opts.json) {
        printJson(value ?? {});
        return;
      }
      if (name) {
        defaultRuntime.log(`MCP server "${name}" (${loaded.path}):`);
      } else {
        defaultRuntime.log(`MCP servers (${loaded.path}):`);
      }
      printJson(value ?? {});
    });

  mcp
    .command("status")
    .description("Show configured MCP server transport status without connecting")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const entries = Object.entries(loaded.mcpServers).toSorted(([a], [b]) => a.localeCompare(b));
      const status = entries.map(([name, server]) => {
        const resolved = resolveMcpTransportConfig(name, server);
        const enabled = server.enabled !== false;
        const entry: McpStatusEntry = {
          name,
          configured: true,
          enabled,
          ok: enabled && Boolean(resolved),
          transport: resolved?.transportType,
          launch: resolved?.description,
          requestTimeoutMs: resolved?.requestTimeoutMs,
          connectionTimeoutMs: resolved?.connectionTimeoutMs,
          supportsParallelToolCalls: resolved?.supportsParallelToolCalls,
          toolFilter: server.toolFilter,
          codex: server.codex,
        };
        if (server.auth) {
          entry.auth = server.auth;
        }
        return entry;
      });
      if (opts.json) {
        printJson({ path: loaded.path, servers: status });
        return;
      }
      if (status.length === 0) {
        defaultRuntime.log(`No MCP servers configured in ${loaded.path}.`);
        return;
      }
      defaultRuntime.log(`MCP server status (${loaded.path}):`);
      for (const entry of status) {
        const transport = entry.enabled ? (entry.transport ?? "invalid") : "disabled";
        const filters = entry.toolFilter ? " tool-filtered" : "";
        defaultRuntime.log(`- ${entry.name}: ${transport}${filters}`);
      }
    });

  mcp
    .command("probe")
    .description("Connect to configured MCP servers and list available capabilities")
    .argument("[name]", "MCP server name")
    .option("--json", "Print JSON")
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const servers = name
        ? loaded.mcpServers[name]
          ? { [name]: loaded.mcpServers[name] }
          : undefined
        : loaded.mcpServers;
      if (!servers) {
        fail(
          `No MCP server named "${name}" in ${loaded.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
        );
      }
      if (name && loaded.mcpServers[name]?.enabled === false) {
        fail(
          `MCP server "${name}" is disabled in ${loaded.path}. Run ${formatCliCommand(`openclaw mcp configure ${name} --enable`)} before probing it.`,
        );
      }
      const runtime = createSessionMcpRuntime({
        sessionId: "openclaw-cli-mcp-probe",
        workspaceDir: process.cwd(),
        cfg: buildMcpProbeConfig({ config: loaded.config, servers }),
        manifestRegistry: { plugins: [] },
      });
      try {
        const result = formatMcpProbeResult(await runtime.getCatalog());
        if (opts.json) {
          printJson(result);
          return;
        }
        defaultRuntime.log(`MCP probe (${loaded.path}):`);
        for (const [serverName, server] of Object.entries(result.servers)) {
          defaultRuntime.log(
            `- ${serverName}: ${server.tools} tools${server.resources ? ", resources" : ""}${server.prompts ? ", prompts" : ""}`,
          );
        }
        for (const diagnostic of result.diagnostics) {
          defaultRuntime.log(`! ${diagnostic.serverName}: ${diagnostic.message}`);
        }
      } finally {
        await runtime.dispose();
      }
    });

  mcp
    .command("add")
    .description("Add one MCP server from flags and probe it before saving")
    .argument("<name>", "MCP server name")
    .option("--command <command>", "Stdio command to spawn")
    .option("--arg <value>", "Repeatable stdio argument", collectOption, [])
    .option("--env <key=value>", "Repeatable stdio environment entry", collectOption, [])
    .option("--cwd <path>", "Working directory for stdio server")
    .option("--url <url>", "HTTP MCP server URL")
    .option("--transport <type>", "HTTP transport: streamable-http or sse")
    .option("--header <key=value>", "Repeatable HTTP header", collectOption, [])
    .option("--auth <mode>", "HTTP auth mode: oauth")
    .option("--oauth-scope <scope>", "OAuth scope")
    .option("--oauth-redirect-url <url>", "OAuth redirect URL")
    .option("--oauth-client-metadata-url <url>", "OAuth client metadata URL")
    .option("--include <csv>", "Comma-separated MCP tool names or '*' globs to expose")
    .option("--exclude <csv>", "Comma-separated MCP tool names or '*' globs to hide")
    .option("--timeout <seconds>", "Per-request timeout in seconds")
    .option("--connect-timeout <seconds>", "Connection timeout in seconds")
    .option("--parallel", "Mark this server safe for concurrent tool calls")
    .option("--disabled", "Save the server disabled", false)
    .option("--ssl-verify <boolean>", "Verify HTTPS certificates: true or false")
    .option("--client-cert <path>", "HTTP mutual TLS client certificate path")
    .option("--client-key <path>", "HTTP mutual TLS client key path")
    .option("--no-probe", "Save without connecting first")
    .action(
      async (
        name: string,
        opts: {
          command?: string;
          arg?: string[];
          env?: string[];
          cwd?: string;
          url?: string;
          transport?: string;
          header?: string[];
          auth?: string;
          oauthScope?: string;
          oauthRedirectUrl?: string;
          oauthClientMetadataUrl?: string;
          include?: string;
          exclude?: string;
          timeout?: string;
          connectTimeout?: string;
          parallel?: boolean;
          disabled?: boolean;
          sslVerify?: string;
          clientCert?: string;
          clientKey?: string;
          probe?: boolean;
        },
      ) => {
        const server: Record<string, unknown> = {};
        const command = normalizeStringifiedOptionalString(opts.command);
        const url = normalizeStringifiedOptionalString(opts.url);
        if (command && url) {
          fail("Specify either --command for stdio or --url for HTTP, not both.");
        }
        if (!command && !url) {
          fail("Specify --command for stdio or --url for HTTP.");
        }
        if (command) {
          server.command = command;
          if (opts.arg && opts.arg.length > 0) {
            server.args = opts.arg;
          }
          setOptionalField(server, "env", parseKeyValueEntries(opts.env, "--env"));
          setOptionalField(server, "cwd", normalizeStringifiedOptionalString(opts.cwd));
        }
        if (url) {
          server.url = url;
          setOptionalField(server, "transport", normalizeStringifiedOptionalString(opts.transport));
          setOptionalField(server, "headers", parseKeyValueEntries(opts.header, "--header"));
          const auth = normalizeLowercaseStringOrEmpty(
            normalizeStringifiedOptionalString(opts.auth) ?? "",
          );
          if (auth && auth !== "oauth") {
            fail('Invalid --auth value. Use "oauth".');
          }
          if (auth) {
            server.auth = auth;
          }
          setOptionalField(
            server,
            "oauth",
            parseOAuthConfig({
              scope: opts.oauthScope,
              redirectUrl: opts.oauthRedirectUrl,
              clientMetadataUrl: opts.oauthClientMetadataUrl,
            }),
          );
          if (opts.sslVerify !== undefined) {
            const sslVerify = normalizeLowercaseStringOrEmpty(opts.sslVerify);
            if (sslVerify !== "true" && sslVerify !== "false") {
              fail("--ssl-verify must be true or false.");
            }
            server.sslVerify = sslVerify === "true";
          }
          setOptionalField(
            server,
            "clientCert",
            normalizeStringifiedOptionalString(opts.clientCert),
          );
          setOptionalField(server, "clientKey", normalizeStringifiedOptionalString(opts.clientKey));
        }
        if (opts.disabled) {
          server.enabled = false;
        }
        if (opts.parallel) {
          server.supportsParallelToolCalls = true;
        }
        setOptionalField(server, "timeout", parsePositiveNumberOption(opts.timeout, "--timeout"));
        setOptionalField(
          server,
          "connectTimeout",
          parsePositiveNumberOption(opts.connectTimeout, "--connect-timeout"),
        );
        const include = parseCsvList(opts.include);
        const exclude = parseCsvList(opts.exclude);
        if (include || exclude) {
          server.toolFilter = {
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
          };
        }

        const loaded = await listConfiguredMcpServers();
        if (!loaded.ok) {
          fail(loaded.error);
        }
        const current = loaded.mcpServers[name];
        const shouldProbe =
          opts.probe !== false && server.enabled !== false && server.auth !== "oauth";
        if (shouldProbe) {
          await probeMcpServersOrFail({
            config: loaded.config,
            path: loaded.path,
            servers: { [name]: server },
          });
        }
        const result = await setConfiguredMcpServer({ name, server });
        if (!result.ok) {
          fail(result.error);
        }
        await clearStaleMcpOAuthCredentialsForReplacement({
          name,
          previous: current,
          next: server,
        });
        defaultRuntime.log(`Saved MCP server "${name}" to ${result.path}.`);
        if (server.auth === "oauth") {
          defaultRuntime.log(
            `Run ${formatCliCommand(`openclaw mcp login ${name}`)} to authorize this MCP server.`,
          );
        }
      },
    );

  mcp
    .command("set")
    .description("Set one configured MCP server from a JSON object")
    .argument("<name>", "MCP server name")
    .argument("<value>", 'JSON object, for example {"command":"uvx","args":["context7-mcp"]}')
    .action(async (name: string, rawValue: string) => {
      const parsed = parseConfigValue(rawValue);
      if (parsed.error) {
        fail(parsed.error);
      }
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const current = loaded.mcpServers[name];
      const result = await setConfiguredMcpServer({ name, server: parsed.value });
      if (!result.ok) {
        fail(result.error);
      }
      await clearStaleMcpOAuthCredentialsForReplacement({
        name,
        previous: current,
        next: parsed.value,
      });
      defaultRuntime.log(`Saved MCP server "${name}" to ${result.path}.`);
    });

  mcp
    .command("tools")
    .description("Update per-server MCP tool include/exclude filters")
    .argument("<name>", "MCP server name")
    .option("--include <csv>", "Comma-separated MCP tool names or '*' globs to expose")
    .option("--exclude <csv>", "Comma-separated MCP tool names or '*' globs to hide")
    .option("--clear", "Clear this server's MCP tool filter", false)
    .action(async (name: string, opts: { include?: string; exclude?: string; clear?: boolean }) => {
      if (!opts.clear && opts.include === undefined && opts.exclude === undefined) {
        fail("Specify --include, --exclude, or --clear.");
      }
      const result = await updateConfiguredMcpServerTools({
        name,
        tools: opts.clear
          ? null
          : {
              include: parseCsvList(opts.include),
              exclude: parseCsvList(opts.exclude),
            },
      });
      if (!result.ok) {
        fail(result.error);
      }
      if (!result.updated) {
        fail(
          `No MCP server named "${name}" in ${result.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
        );
      }
      defaultRuntime.log(`Updated MCP tool selection for "${name}" in ${result.path}.`);
    });

  mcp
    .command("configure")
    .description("Update MCP server operator controls without replacing the server")
    .argument("<name>", "MCP server name")
    .option("--enable", "Enable this saved server", false)
    .option("--disable", "Disable this saved server", false)
    .option("--include <csv>", "Comma-separated MCP tool names or '*' globs to expose")
    .option("--exclude <csv>", "Comma-separated MCP tool names or '*' globs to hide")
    .option("--clear-tools", "Clear this server's MCP tool filter", false)
    .option("--timeout <seconds>", "Per-request timeout in seconds")
    .option("--connect-timeout <seconds>", "Connection timeout in seconds")
    .option("--clear-timeouts", "Clear request and connection timeout overrides", false)
    .option("--parallel", "Mark this server safe for concurrent tool calls")
    .option("--no-parallel", "Clear the concurrent tool-call marker")
    .option("--auth <mode>", "HTTP auth mode: oauth")
    .option("--clear-auth", "Clear auth and OAuth metadata", false)
    .option("--oauth-scope <scope>", "OAuth scope")
    .option("--oauth-redirect-url <url>", "OAuth redirect URL")
    .option("--oauth-client-metadata-url <url>", "OAuth client metadata URL")
    .option("--ssl-verify <boolean>", "Verify HTTPS certificates: true or false")
    .option("--client-cert <path>", "HTTP mutual TLS client certificate path")
    .option("--client-key <path>", "HTTP mutual TLS client key path")
    .option("--clear-tls", "Clear TLS verification and mTLS overrides", false)
    .option("--probe", "Probe the updated server before saving", false)
    .action(
      async (
        name: string,
        opts: {
          enable?: boolean;
          disable?: boolean;
          include?: string;
          exclude?: string;
          clearTools?: boolean;
          timeout?: string;
          connectTimeout?: string;
          clearTimeouts?: boolean;
          parallel?: boolean;
          auth?: string;
          clearAuth?: boolean;
          oauthScope?: string;
          oauthRedirectUrl?: string;
          oauthClientMetadataUrl?: string;
          sslVerify?: string;
          clientCert?: string;
          clientKey?: string;
          clearTls?: boolean;
          probe?: boolean;
        },
      ) => {
        if (opts.enable && opts.disable) {
          fail("Specify only one of --enable or --disable.");
        }
        const loaded = await listConfiguredMcpServers();
        if (!loaded.ok) {
          fail(loaded.error);
        }
        const current = loaded.mcpServers[name];
        if (!current) {
          fail(
            `No MCP server named "${name}" in ${loaded.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
          );
        }
        const next = { ...current };
        const clearOAuthCredentials = opts.clearAuth;
        if (opts.enable) {
          delete next.enabled;
        }
        if (opts.disable) {
          next.enabled = false;
        }
        if (opts.clearTools) {
          delete next.toolFilter;
        } else {
          const include = parseCsvList(opts.include);
          const exclude = parseCsvList(opts.exclude);
          if (include || exclude) {
            next.toolFilter = {
              ...(include ? { include } : {}),
              ...(exclude ? { exclude } : {}),
            };
          }
        }
        if (opts.clearTimeouts) {
          delete next.timeout;
          delete next.connectTimeout;
          delete next.connect_timeout;
          delete next.requestTimeoutMs;
          delete next.connectionTimeoutMs;
        }
        setOptionalField(next, "timeout", parsePositiveNumberOption(opts.timeout, "--timeout"));
        setOptionalField(
          next,
          "connectTimeout",
          parsePositiveNumberOption(opts.connectTimeout, "--connect-timeout"),
        );
        if (opts.parallel === true) {
          next.supportsParallelToolCalls = true;
        } else if (opts.parallel === false) {
          delete next.supportsParallelToolCalls;
          delete next.supports_parallel_tool_calls;
        }
        if (opts.clearAuth) {
          delete next.auth;
          delete next.oauth;
        }
        const auth = normalizeLowercaseStringOrEmpty(
          normalizeStringifiedOptionalString(opts.auth) ?? "",
        );
        if (auth && auth !== "oauth") {
          fail('Invalid --auth value. Use "oauth".');
        }
        if (auth) {
          next.auth = auth;
        }
        const oauth = parseOAuthConfig({
          scope: opts.oauthScope,
          redirectUrl: opts.oauthRedirectUrl,
          clientMetadataUrl: opts.oauthClientMetadataUrl,
        });
        if (oauth) {
          next.oauth = oauth;
        }
        if (opts.clearTls) {
          delete next.sslVerify;
          delete next.ssl_verify;
          delete next.clientCert;
          delete next.client_cert;
          delete next.clientKey;
          delete next.client_key;
        }
        if (opts.sslVerify !== undefined) {
          const sslVerify = normalizeLowercaseStringOrEmpty(opts.sslVerify);
          if (sslVerify !== "true" && sslVerify !== "false") {
            fail("--ssl-verify must be true or false.");
          }
          next.sslVerify = sslVerify === "true";
        }
        setOptionalField(next, "clientCert", normalizeStringifiedOptionalString(opts.clientCert));
        setOptionalField(next, "clientKey", normalizeStringifiedOptionalString(opts.clientKey));
        if (opts.probe && next.enabled !== false && next.auth !== "oauth") {
          await probeMcpServersOrFail({
            config: loaded.config,
            path: loaded.path,
            servers: { [name]: next },
          });
        }
        if (opts.enable && Object.keys(next).length === 0) {
          const result = await unsetConfiguredMcpServer({ name });
          if (!result.ok) {
            fail(result.error);
          }
          if (clearOAuthCredentials) {
            await clearMcpOAuthCredentialsForConfiguredServer(name, current);
          }
          defaultRuntime.log(`Removed disabled MCP override for "${name}" in ${result.path}.`);
          return;
        }
        const result = await updateConfiguredMcpServer({
          name,
          update: () => next,
        });
        if (!result.ok) {
          fail(result.error);
        }
        if (!result.updated) {
          fail(
            `No MCP server named "${name}" in ${result.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
          );
        }
        if (clearOAuthCredentials) {
          await clearMcpOAuthCredentialsForConfiguredServer(name, current);
        }
        defaultRuntime.log(`Updated MCP server "${name}" in ${result.path}.`);
      },
    );

  mcp
    .command("login")
    .description("Authorize an OAuth MCP server")
    .argument("<name>", "MCP server name")
    .option("--code <code>", "Authorization code from the OAuth redirect")
    .action(async (name: string, opts: { code?: string }) => {
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const server = loaded.mcpServers[name];
      if (!server) {
        fail(
          `No MCP server named "${name}" in ${loaded.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
        );
      }
      if (server.auth !== "oauth") {
        fail(`MCP server "${name}" is not configured with auth: "oauth".`);
      }
      if (typeof server.url !== "string" || server.url.trim().length === 0) {
        fail(`MCP server "${name}" needs a URL for OAuth login.`);
      }
      const resolved = resolveMcpTransportConfig(name, server);
      if (!resolved || resolved.kind !== "http") {
        fail(`MCP server "${name}" needs a valid HTTP transport for OAuth login.`);
      }
      const result = await runMcpOAuthLogin({
        serverName: name,
        serverUrl: resolved.url,
        config: server.oauth as Record<string, string> | undefined,
        authorizationCode: opts.code,
        fetchFn: withSameOriginMcpHttpHeaders({
          fetchFn: buildMcpHttpFetch({
            sslVerify: resolved.sslVerify,
            clientCert: resolved.clientCert,
            clientKey: resolved.clientKey,
            resourceUrl: resolved.url,
          }),
          headers: withoutMcpAuthorizationHeader(resolved.headers),
          resourceUrl: resolved.url,
        }),
        onAuthorizationUrl: (url) => {
          defaultRuntime.log(`Open this URL to authorize "${name}":`);
          defaultRuntime.log(url.toString());
          defaultRuntime.log(
            `After approval, run ${formatCliCommand(`openclaw mcp login ${name} --code <code>`)}.`,
          );
        },
      });
      if (result === "authorized") {
        defaultRuntime.log(`MCP OAuth credentials saved for "${name}".`);
      }
    });

  mcp
    .command("reload")
    .description("Dispose cached MCP runtimes so new config is used on the next turn")
    .action(async () => {
      const { disposeAllSessionMcpRuntimes } =
        await import("../agents/agent-bundle-mcp-runtime.js");
      await disposeAllSessionMcpRuntimes();
      defaultRuntime.log(
        "Disposed cached MCP runtimes. Active agents use new MCP config on their next runtime build.",
      );
    });

  mcp
    .command("unset")
    .description("Remove one configured MCP server")
    .argument("<name>", "MCP server name")
    .action(async (name: string) => {
      const loaded = await listConfiguredMcpServers();
      if (!loaded.ok) {
        fail(loaded.error);
      }
      const current = loaded.mcpServers[name];
      const result = await unsetConfiguredMcpServer({ name });
      if (!result.ok) {
        fail(result.error);
      }
      if (!result.removed) {
        fail(
          `No MCP server named "${name}" in ${result.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
        );
      }
      if (current) {
        await clearMcpOAuthCredentialsForConfiguredServer(name, current);
      }
      defaultRuntime.log(`Removed MCP server "${name}" from ${result.path}.`);
    });

  applyParentDefaultHelpAction(mcp);
}
