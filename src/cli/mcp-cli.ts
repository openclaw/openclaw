import { Command } from "commander";
import { buildBundleMcpToolsFromCatalog } from "../agents/agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { parseConfigValue } from "../auto-reply/reply/config-value.js";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
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
        return {
          name,
          configured: true,
          ok: Boolean(resolved),
          transport: resolved?.transportType,
          launch: resolved?.description,
          toolFilter: server.toolFilter,
          codex: server.codex,
        };
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
        const transport = entry.transport ?? "invalid";
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
    .command("set")
    .description("Set one configured MCP server from a JSON object")
    .argument("<name>", "MCP server name")
    .argument("<value>", 'JSON object, for example {"command":"uvx","args":["context7-mcp"]}')
    .action(async (name: string, rawValue: string) => {
      const parsed = parseConfigValue(rawValue);
      if (parsed.error) {
        fail(parsed.error);
      }
      const result = await setConfiguredMcpServer({ name, server: parsed.value });
      if (!result.ok) {
        fail(result.error);
      }
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
    .command("unset")
    .description("Remove one configured MCP server")
    .argument("<name>", "MCP server name")
    .action(async (name: string) => {
      const result = await unsetConfiguredMcpServer({ name });
      if (!result.ok) {
        fail(result.error);
      }
      if (!result.removed) {
        fail(
          `No MCP server named "${name}" in ${result.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
        );
      }
      defaultRuntime.log(`Removed MCP server "${name}" from ${result.path}.`);
    });

  applyParentDefaultHelpAction(mcp);
}
