import path from "node:path";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringifiedOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { Command } from "commander";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStoreReadOnly } from "../agents/mcp-oauth-store.js";
import {
  countMcpOAuthPrincipals,
  readMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { parseConfigValue } from "../auto-reply/reply/config-value.js";
import { renderEnvTemplateToken, scanEnvTemplateTokens } from "../config/env-substitution.js";
import { listConfiguredMcpServers, redactMcpServersForDisplay } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executableFileExists, safeStat } from "../infra/path-existence.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { registerMcpOAuthCommands } from "./mcp-cli-oauth.js";
import {
  formatMcpProbeIssues,
  probeMcpServers,
  probeMcpServersOrFail,
  resolveMcpProbeIssue,
} from "./mcp-cli-probe.js";
import { resolveMcpServeOptions } from "./mcp-cli-serve-options.js";
import {
  applyMcpHttpControls,
  applyMcpServerControls,
  parseCsvList,
  setOptionalField,
  type McpServerControlOptions,
} from "./mcp-cli-server-controls.js";
import {
  offlineMcpAction,
  setMcpServer,
  unsetMcpServer,
  configureMcpServer,
  updateMcpTools,
} from "./mcp-cli-state-owner.js";
import { exitCliAfterOutput, requestExitAfterOneShotOutput } from "./one-shot-exit.js";
import { parseKeyValueEntries } from "./parse-key-value-entries.js";
import { collectOption } from "./program/helpers.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

const disposeAllSessionMcpRuntimes = createLazyRuntimeMethod(
  () => import("../agents/agent-bundle-mcp-manager-api.js"),
  (runtime) => runtime.disposeAllSessionMcpRuntimes,
);

const PROBE_ONLINE_ALTERNATIVE =
  "Probing a server needs the Gateway stopped. Save without probing (mcp add --no-probe, or mcp configure without --probe) to use the running Gateway.";

function fail(message: string, json?: boolean): never {
  if (json) {
    defaultRuntime.writeJson(formatCliJsonFailure(message));
  } else {
    defaultRuntime.error(terminalText`${message}`);
  }
  exitCliAfterOutput(defaultRuntime, 1);
}

async function loadMcpConfig(opts?: { json?: boolean }) {
  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    fail(loaded.error, opts?.json);
  }
  return loaded;
}

type LoadedMcpConfig = Awaited<ReturnType<typeof loadMcpConfig>>;

function failUnknownMcpServer(
  name: string | undefined,
  configPath: string,
  opts?: { json?: boolean },
): never {
  fail(
    `No MCP server named "${name}" in ${configPath}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`,
    opts?.json,
  );
}

function requireMcpServer(loaded: LoadedMcpConfig, name: string, opts?: { json?: boolean }) {
  const server = loaded.mcpServers[name];
  if (!server) {
    failUnknownMcpServer(name, loaded.path, opts);
  }
  return server;
}

function selectMcpServers(
  loaded: LoadedMcpConfig,
  name: string | undefined,
  opts?: { json?: boolean },
) {
  return name ? { [name]: requireMcpServer(loaded, name, opts) } : loaded.mcpServers;
}

type McpStatusAuthStatusJson = McpOAuthPrincipalStatus & {
  hasTokens: boolean;
  requiresAuthorization: boolean;
  hasClientInformation: boolean;
  hasCodeVerifier: boolean;
  hasDiscoveryState: boolean;
  hasLastAuthorizationUrl: boolean;
};

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
  authStatus?: McpStatusAuthStatusJson;
  connectedPrincipals?: number;
  toolFilter?: unknown;
  codex?: unknown;
};

type McpDoctorIssue = {
  level: "error" | "warning" | "info";
  message: string;
};

const MCP_DOCTOR_CONCURRENCY = 4;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "api_key",
]);

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(api[_-]?key|authorization|bearer|password|secret|token)$/i;

function issue(level: McpDoctorIssue["level"], message: string): McpDoctorIssue {
  return { level, message };
}

function hasSensitiveKey(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase()) || SENSITIVE_KEY_PATTERN.test(name);
}

function hasLiteralSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const tokens = scanEnvTemplateTokens(value);
  let literal = value;
  for (const token of tokens) {
    if (token.kind === "escaped" || token.defaultValue?.trim()) {
      return true;
    }
    literal = literal.replaceAll(renderEnvTemplateToken(token), "");
  }
  return (
    tokens.length === 0 || (literal.trim().length > 0 && !/^(Bearer|Basic)$/i.test(literal.trim()))
  );
}

function resolveConfiguredPath(filePath: string, cwd: unknown): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  const base = typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
  return path.resolve(base, filePath);
}

function executableCandidates(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (path.extname(command)) {
    return [command];
  }
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function commandExists(
  command: string,
  cwd: unknown,
  env: Record<string, string> | undefined,
): Promise<boolean> {
  const hasPathSeparator =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    return executableFileExists(resolveConfiguredPath(command, cwd));
  }
  const configuredPath =
    process.platform === "win32" ? resolveEnvironmentValue(env, "PATH") : env?.PATH;
  const pathEntries = (configuredPath ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim() || ".");
  for (const pathEntry of pathEntries) {
    const resolvedPathEntry = path.isAbsolute(pathEntry)
      ? pathEntry
      : resolveConfiguredPath(pathEntry, cwd);
    for (const candidate of executableCandidates(command)) {
      if (await executableFileExists(path.join(resolvedPathEntry, candidate))) {
        return true;
      }
    }
  }
  return false;
}

async function collectMcpDoctorIssues(params: {
  name: string;
  server: Record<string, unknown>;
  authoredServer?: Record<string, unknown>;
  probe: boolean;
  config: OpenClawConfig;
}): Promise<McpDoctorIssue[]> {
  const issues: McpDoctorIssue[] = [];
  const { name, server } = params;
  const resolved = resolveMcpTransportConfig(name, server);
  const disabled = server.enabled === false;
  if (disabled) {
    issues.push(issue("warning", "server is disabled"));
  }
  if (!disabled) {
    if (!resolved) {
      issues.push(issue("error", "server transport is invalid"));
    }
    if (resolved?.kind === "stdio") {
      if (!(await commandExists(resolved.command, resolved.cwd, resolved.env))) {
        issues.push(
          issue("error", `stdio command not found or not executable: ${resolved.command}`),
        );
      }
      if (resolved.cwd && !(await safeStat(resolved.cwd))?.isDirectory()) {
        issues.push(issue("error", `stdio cwd does not exist: ${resolved.cwd}`));
      }
    }
    if (resolved?.kind === "http") {
      if (server.auth === "oauth") {
        if (asRecord(server.oauth)?.identity !== "per-requester") {
          const authStatus = await readMcpOAuthCredentialsStatus(
            operatorMcpOAuthIdentity(name, resolved.url),
          );
          if (authStatus.state !== "authorized") {
            const state =
              authStatus.state === "requires-authorization"
                ? "require additional authorization"
                : "are not authorized";
            issues.push(
              issue(
                "warning",
                `OAuth credentials ${state}; run ${formatCliCommand(`openclaw mcp login ${name}`)}`,
              ),
            );
          }
        }
        const headers = asRecord(server.headers);
        if (headers && Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
          issues.push(
            issue("warning", "OAuth is enabled and the static Authorization header is ignored"),
          );
        }
      }
      if (resolved.sslVerify === false) {
        issues.push(issue("warning", "TLS certificate verification is disabled"));
      }
      for (const [filePath, label] of [
        [resolved.clientCert, "client certificate"],
        [resolved.clientKey, "client key"],
      ]) {
        if (filePath && !(await safeStat(resolveConfiguredPath(filePath, "")))?.isFile()) {
          issues.push(issue("error", `${label} file does not exist: ${filePath}`));
        }
      }
    }
  }
  for (const [field, values] of [
    ["headers", asRecord(params.authoredServer?.headers)],
    ["env", asRecord(params.authoredServer?.env)],
  ] as const) {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (hasSensitiveKey(key) && hasLiteralSensitiveValue(value)) {
        issues.push(
          issue(
            "warning",
            `${field}.${key} contains a literal sensitive value; prefer an environment-backed value outside committed config`,
          ),
        );
      }
    }
  }
  const toolFilter = asRecord(server.toolFilter);
  if (toolFilter && !Array.isArray(toolFilter.include) && !Array.isArray(toolFilter.exclude)) {
    issues.push(issue("warning", "toolFilter is present but has no include or exclude list"));
  }
  if (
    params.probe &&
    server.enabled !== false &&
    !issues.some((entry) => entry.level === "error")
  ) {
    try {
      const result = await probeMcpServers("openclaw-cli-mcp-doctor", params.config, {
        [name]: server,
      });
      const diagnostic = result.diagnostics[0];
      if (diagnostic) {
        issues.push(issue("error", `check failed: ${diagnostic.message}`));
      } else {
        const connectedServer = result.servers[name];
        if (!connectedServer) {
          issues.push(issue("error", "check did not connect to this server"));
        } else if (connectedServer.approvalHint) {
          issues.push(
            issue(
              "info",
              `Codex approval mode: ${connectedServer.codexApprovalMode}; ${connectedServer.approvalHint}`,
            ),
          );
        }
      }
      if (result.cleanupError) {
        issues.push(issue("error", `cleanup failed: ${result.cleanupError}`));
      }
    } catch (err) {
      issues.push(issue("error", `check failed: ${formatErrorMessage(err)}`));
    }
  }
  return issues;
}

async function countConnectedMcpPrincipals(
  name: string,
  server: Record<string, unknown>,
): Promise<number | undefined> {
  const resolved = resolveMcpTransportConfig(name, server);
  if (
    server.auth !== "oauth" ||
    resolved?.kind !== "http" ||
    asRecord(server.oauth)?.identity !== "per-requester"
  ) {
    return undefined;
  }
  return countMcpOAuthPrincipals(operatorMcpOAuthIdentity(name, resolved.url));
}

async function buildMcpStatusEntries(
  servers: Record<string, Record<string, unknown>>,
): Promise<McpStatusEntry[]> {
  const entries = Object.entries(servers).toSorted(([a], [b]) => a.localeCompare(b));
  return Promise.all(
    entries.map(async ([name, server]) => {
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
      if (
        server.auth === "oauth" &&
        resolved?.kind === "http" &&
        asRecord(server.oauth)?.identity !== "per-requester"
      ) {
        const identity = operatorMcpOAuthIdentity(name, resolved.url);
        // Documented `mcp status --json` contract: the six legacy authStatus
        // booleans stay for existing scripts; `state` is the additive shape.
        const store = await readMcpOAuthStoreReadOnly(identity.storeKey);
        entry.authStatus = {
          hasTokens: Boolean(store.tokens),
          requiresAuthorization:
            store.pendingAuthorizationChallenge?.requiresAuthorization === true,
          hasClientInformation: Boolean(store.clientInformation),
          hasCodeVerifier: Boolean(store.codeVerifier),
          hasDiscoveryState: Boolean(store.discoveryState),
          hasLastAuthorizationUrl: Boolean(store.lastAuthorizationUrl),
          ...(await readMcpOAuthCredentialsStatus(identity, store)),
        };
      } else {
        entry.connectedPrincipals = await countConnectedMcpPrincipals(name, server);
      }
      return entry;
    }),
  );
}

const OPENCLAW_MCP_REGISTRY_SCOPE_NOTE =
  "Note: this command only shows OpenClaw-managed mcp.servers entries and does not include mcporter servers from config/mcporter.json.";

export function registerMcpCli(program: Command) {
  const mcp = program
    .command("mcp")
    .description("Manage OpenClaw mcp.servers config and channel bridge");

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
      let serveOptions: ReturnType<typeof resolveMcpServeOptions>;
      try {
        serveOptions = resolveMcpServeOptions(opts);
      } catch (err) {
        fail(formatErrorMessage(err));
      }
      try {
        const { serveOpenClawChannelMcp } = await import("../mcp/channel-server.js");
        await serveOpenClawChannelMcp(serveOptions);
      } catch (err) {
        const reason = formatErrorMessage(err).replace(/\.+$/u, "");
        defaultRuntime.error(
          terminalText`MCP server failed to start: ${reason}. Run ${formatCliCommand("openclaw gateway status --deep --require-rpc")} to inspect Gateway health.`,
        );
        exitCliAfterOutput(defaultRuntime, 1);
      }
    });

  mcp
    .command("list")
    .description("List OpenClaw-managed MCP servers from mcp.servers")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const loaded = await loadMcpConfig(opts);
      if (opts.json) {
        defaultRuntime.writeJson(redactMcpServersForDisplay(loaded.mcpServers));
        return;
      }
      const entries = Object.entries(loaded.mcpServers).toSorted(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) {
        defaultRuntime.log(
          terminalText`No OpenClaw-managed MCP servers configured in ${loaded.path}. Add one with ${formatCliCommand('openclaw mcp set <name> \'{"command":"uvx","args":["context7-mcp"]}\'')}.`,
        );
        defaultRuntime.log(OPENCLAW_MCP_REGISTRY_SCOPE_NOTE);
        return;
      }
      defaultRuntime.log(terminalText`OpenClaw-managed MCP servers (${loaded.path}):`);
      for (const [name, server] of entries) {
        const connectedPrincipals = await countConnectedMcpPrincipals(name, server);
        const connected =
          connectedPrincipals === undefined
            ? ""
            : ` (${connectedPrincipals} connected principal${connectedPrincipals === 1 ? "" : "s"})`;
        defaultRuntime.log(terminalText`- ${name}${connected}`);
      }
      defaultRuntime.log("");
      defaultRuntime.log(OPENCLAW_MCP_REGISTRY_SCOPE_NOTE);
    });

  mcp
    .command("show")
    .description("Show one OpenClaw-managed MCP server or the full mcp.servers config")
    .argument("[name]", "MCP server name")
    .option("--json", "Print JSON")
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const loaded = await loadMcpConfig(opts);
      const value = redactMcpServersForDisplay(selectMcpServers(loaded, name, opts));
      if (!opts.json) {
        defaultRuntime.log(
          name
            ? terminalText`OpenClaw-managed MCP server "${name}" (${loaded.path}):`
            : terminalText`OpenClaw-managed MCP servers (${loaded.path}):`,
        );
      }
      defaultRuntime.writeJson(name ? value[name] : value);
    });

  mcp
    .command("status")
    .description("Show configured MCP server transport status without connecting")
    .option("-v, --verbose", "Show transport, auth, timeout, and filter details", false)
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean; verbose?: boolean }) => {
      const loaded = await loadMcpConfig(opts);
      const status = await buildMcpStatusEntries(loaded.mcpServers);
      if (opts.json) {
        defaultRuntime.writeJson({ path: loaded.path, servers: status });
        return;
      }
      if (status.length === 0) {
        defaultRuntime.log(terminalText`No MCP servers configured in ${loaded.path}.`);
        return;
      }
      defaultRuntime.log(terminalText`MCP server status (${loaded.path}):`);
      for (const entry of status) {
        const transport = entry.enabled ? (entry.transport ?? "invalid") : "disabled";
        const auth = entry.auth === "oauth" ? " oauth" : "";
        const oauth =
          entry.authStatus?.state === "requires-authorization"
            ? " authorization-required"
            : entry.authStatus?.state === "authorized"
              ? " authorized"
              : "";
        const filters = entry.toolFilter ? " tool-filtered" : "";
        const parallel = entry.supportsParallelToolCalls ? " parallel" : "";
        const connected =
          entry.connectedPrincipals === undefined
            ? ""
            : ` ${entry.connectedPrincipals}-principal${entry.connectedPrincipals === 1 ? "" : "s"}-connected`;
        defaultRuntime.log(
          terminalText`- ${entry.name}: ${transport}${auth}${oauth}${connected}${filters}${parallel}`,
        );
        if (opts.verbose) {
          defaultRuntime.log(terminalText`  launch: ${entry.launch ?? "n/a"}`);
          defaultRuntime.log(
            terminalText`  timeouts: connect=${entry.connectionTimeoutMs ?? "n/a"}ms request=${entry.requestTimeoutMs ?? "n/a"}ms`,
          );
          if (entry.auth === "oauth") {
            defaultRuntime.log(
              entry.connectedPrincipals === undefined
                ? terminalText`  oauth: ${entry.authStatus?.state ?? "unauthenticated"}`
                : terminalText`  oauth: per-requester, connected principals: ${entry.connectedPrincipals}`,
            );
          }
          if (entry.toolFilter) {
            defaultRuntime.log(terminalText`  tools: ${JSON.stringify(entry.toolFilter)}`);
          }
        }
      }
    });

  mcp
    .command("probe")
    .description("Connect to configured MCP servers and list available capabilities")
    .argument("[name]", "MCP server name")
    .option("--json", "Print JSON")
    .action(
      offlineMcpAction(
        "probe",
        async (_owner, name: string | undefined, opts: { json?: boolean }) => {
          const loaded = await loadMcpConfig(opts);
          const servers = selectMcpServers(loaded, name, opts);
          if (name && loaded.mcpServers[name]?.enabled === false) {
            fail(
              `MCP server "${name}" is disabled in ${loaded.path}. Run ${formatCliCommand(`openclaw mcp configure ${name} --enable`)} before checking it.`,
              opts.json,
            );
          }
          // Empty and disabled-only registries have no live probe rows to print.
          // Explain the intentional non-outcome; JSON keeps its existing empty envelope.
          if (!opts.json && Object.values(servers).every((server) => server.enabled === false)) {
            defaultRuntime.log(
              terminalText`No enabled MCP servers in ${loaded.path}. Add one with ${formatCliCommand("openclaw mcp add <name> --command <command>")} or enable one with ${formatCliCommand("openclaw mcp configure <name> --enable")}.`,
            );
            return;
          }
          const result = await probeMcpServers("openclaw-cli-mcp-probe", loaded.config, servers);
          if (opts.json) {
            defaultRuntime.writeJson(result);
          } else {
            defaultRuntime.log(terminalText`MCP check (${loaded.path}):`);
            for (const [serverName, server] of Object.entries(result.servers)) {
              defaultRuntime.log(
                terminalText`- ${serverName}: ${server.tools} tools${server.resources ? ", resources" : ""}${server.prompts ? ", prompts" : ""}, Codex approval ${server.codexApprovalMode}`,
              );
              if (server.approvalHint) {
                defaultRuntime.log(terminalText`  i ${server.approvalHint}`);
              }
            }
            for (const diagnostic of result.diagnostics) {
              defaultRuntime.log(terminalText`! ${diagnostic.serverName}: ${diagnostic.message}`);
            }
            if (result.cleanupError) {
              defaultRuntime.log(terminalText`! cleanup: ${result.cleanupError}`);
            }
          }
          const probeIssues = resolveMcpProbeIssue({ result, servers, path: loaded.path });
          if (probeIssues.length > 0) {
            defaultRuntime.error(formatMcpProbeIssues(probeIssues));
            if (!requestExitAfterOneShotOutput(defaultRuntime, 1)) {
              exitCliAfterOutput(defaultRuntime, 1);
            }
          }
        },
      ),
    );

  mcp
    .command("doctor")
    .description("Check configured MCP servers for static setup problems")
    .argument("[name]", "MCP server name")
    .option("--probe", "Also connect to each checked server", false)
    .option("--json", "Print JSON")
    .action(async (name: string | undefined, opts: { probe?: boolean; json?: boolean }) => {
      const run = async () => {
        const loaded = await loadMcpConfig(opts);
        const selected = selectMcpServers(loaded, name, opts);
        const tasks = Object.entries(selected)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([serverName, server]) => async () => {
            const issues = await collectMcpDoctorIssues({
              name: serverName,
              server,
              authoredServer: loaded.authoredConfig?.mcp?.servers?.[serverName],
              config: loaded.config,
              probe: Boolean(opts.probe),
            });
            return {
              name: serverName,
              ok: !issues.some((entry) => entry.level === "error"),
              issues,
            };
          });
        // A probe can start one process or connection per server. Keep large
        // registries from fanning out every transport at once.
        const {
          results: servers,
          firstError,
          hasError,
        } = await runTasksWithConcurrency({
          tasks,
          limit: MCP_DOCTOR_CONCURRENCY,
        });
        if (hasError) {
          throw firstError;
        }
        const ok = servers.every((server) => server.ok);
        if (opts.json) {
          defaultRuntime.writeJson({ path: loaded.path, ok, servers });
          if (!ok) {
            fail("MCP doctor found errors.");
          }
          return;
        }
        if (servers.length === 0) {
          defaultRuntime.log(
            terminalText`No MCP servers configured in ${loaded.path}. Add one with ${formatCliCommand("openclaw mcp add <name> --command <command>")}.`,
          );
          return;
        }
        defaultRuntime.log(terminalText`MCP doctor (${loaded.path}):`);
        for (const server of servers) {
          defaultRuntime.log(terminalText`- ${server.name}: ${server.ok ? "ok" : "issues"}`);
          for (const entry of server.issues) {
            const prefix = entry.level === "error" ? "!" : entry.level === "warning" ? "-" : "i";
            defaultRuntime.log(terminalText`  ${prefix} ${entry.level}: ${entry.message}`);
          }
        }
        if (!ok) {
          fail("MCP doctor found errors.");
        }
      };
      if (opts.probe) {
        await offlineMcpAction("doctor --probe", run)();
      } else {
        await run();
      }
    });

  mcp
    .command("add")
    .description("Add one MCP server from flags and check it before saving")
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
    .option("--approval <mode>", "Codex MCP tool approval mode: auto, prompt, or approve")
    .option("--disabled", "Save the server disabled", false)
    .option("--ssl-verify <boolean>", "Verify HTTPS certificates: true or false")
    .option("--client-cert <path>", "HTTP mutual TLS client certificate path")
    .option("--client-key <path>", "HTTP mutual TLS client key path")
    .option("--no-probe", "Save without connecting first")
    .action(
      async (
        name: string,
        opts: McpServerControlOptions & {
          command?: string;
          arg?: string[];
          env?: string[];
          cwd?: string;
          url?: string;
          transport?: string;
          header?: string[];
          disabled?: boolean;
        },
      ) => {
        const server: Record<string, unknown> = {};
        const command = readNonBlankString(opts.command);
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
          setOptionalField(server, "env", parseKeyValueEntries(opts.env, "--env", fail));
          setOptionalField(server, "cwd", readNonBlankString(opts.cwd));
        }
        if (url) {
          server.url = url;
          setOptionalField(server, "transport", normalizeStringifiedOptionalString(opts.transport));
          setOptionalField(server, "headers", parseKeyValueEntries(opts.header, "--header", fail));
          applyMcpHttpControls(server, opts, fail);
        }
        if (opts.disabled) {
          server.enabled = false;
        }
        applyMcpServerControls(server, opts, fail);

        const probing = opts.probe !== false && server.enabled !== false && server.auth !== "oauth";
        const save = async () => {
          const loaded = await loadMcpConfig();
          const targetName = name.trim();
          if (targetName && Object.hasOwn(loaded.mcpServers, targetName)) {
            fail(`MCP server ${JSON.stringify(targetName)} already exists.`);
          }
          if (probing) {
            await probeMcpServersOrFail({
              config: loaded.config,
              path: loaded.path,
              servers: { [name]: server },
            });
          }
          return setMcpServer({ name, server, createOnly: true });
        };
        // Probes launch the server under offline custody; unprobed saves use the running Gateway.
        const result = probing
          ? await offlineMcpAction("add", save, PROBE_ONLINE_ALTERNATIVE)()
          : await save();
        if (!result.ok) {
          fail(result.error);
        }
        defaultRuntime.log(terminalText`Saved MCP server "${name}" to ${result.path}.`);
        if (server.auth === "oauth") {
          defaultRuntime.log(
            terminalText`Run ${formatCliCommand(`openclaw mcp login ${name}`)} to authorize this MCP server.`,
          );
        }
      },
    );

  mcp
    .command("set")
    .description("Set one OpenClaw-managed MCP server from a JSON object")
    .argument("<name>", "MCP server name")
    .argument("<value>", 'JSON object, for example {"command":"uvx","args":["context7-mcp"]}')
    .action(async (name: string, rawValue: string) => {
      const parsed = parseConfigValue(rawValue);
      if (parsed.error) {
        fail(parsed.error);
      }
      const result = await setMcpServer({ name, server: parsed.value });
      if (!result.ok) {
        fail(result.error);
      }
      defaultRuntime.log(terminalText`Saved MCP server "${name}" to ${result.path}.`);
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
      const result = await updateMcpTools({
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
        failUnknownMcpServer(name, result.path);
      }
      defaultRuntime.log(terminalText`Updated MCP tool selection for "${name}" in ${result.path}.`);
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
    .option("--approval <mode>", "Codex MCP tool approval mode: auto, prompt, or approve")
    .option("--auth <mode>", "HTTP auth mode: oauth")
    .option("--clear-auth", "Clear auth and OAuth metadata", false)
    .option("--oauth-scope <scope>", "OAuth scope")
    .option("--oauth-redirect-url <url>", "OAuth redirect URL")
    .option("--oauth-client-metadata-url <url>", "OAuth client metadata URL")
    .option("--ssl-verify <boolean>", "Verify HTTPS certificates: true or false")
    .option("--client-cert <path>", "HTTP mutual TLS client certificate path")
    .option("--client-key <path>", "HTTP mutual TLS client key path")
    .option("--clear-tls", "Clear TLS verification and mTLS overrides", false)
    .option("--probe", "Check the updated server before saving", false)
    .action(
      async (
        name: string,
        opts: McpServerControlOptions & {
          enable?: boolean;
          disable?: boolean;
        },
      ) => {
        if (opts.enable && opts.disable) {
          fail("Specify only one of --enable or --disable.");
        }
        const apply = async () => {
          const loaded = await loadMcpConfig();
          const current = requireMcpServer(loaded, name);
          const next = { ...current };
          if (opts.enable) {
            delete next.enabled;
          }
          if (opts.disable) {
            next.enabled = false;
          }
          applyMcpServerControls(next, opts, fail);
          applyMcpHttpControls(next, opts, fail);
          if (opts.probe && next.enabled !== false && next.auth !== "oauth") {
            await probeMcpServersOrFail({
              config: loaded.config,
              path: loaded.path,
              servers: { [name]: next },
            });
          }
          if (opts.enable && Object.keys(next).length === 0) {
            const result = await unsetMcpServer({ name });
            if (!result.ok) {
              fail(result.error);
            }
            defaultRuntime.log(
              terminalText`Removed disabled MCP override for "${name}" in ${result.path}.`,
            );
            return;
          }
          const result = await configureMcpServer({ name, update: () => next });
          if (!result.ok) {
            fail(result.error);
          }
          if (!result.updated) {
            failUnknownMcpServer(name, result.path);
          }
          defaultRuntime.log(terminalText`Updated MCP server "${name}" in ${result.path}.`);
        };
        // Probes launch the server under offline custody; unprobed saves use the running Gateway.
        await (opts.probe
          ? offlineMcpAction("configure", apply, PROBE_ONLINE_ALTERNATIVE)()
          : apply());
      },
    );

  registerMcpOAuthCommands(mcp, {
    fail,
    loadServer: async (name) => requireMcpServer(await loadMcpConfig(), name),
  });

  mcp
    .command("reload")
    .description("Dispose cached MCP runtimes so new config is used on the next turn")
    .action(async () => {
      await disposeAllSessionMcpRuntimes();
      defaultRuntime.log(
        "Disposed cached MCP runtimes. Active agents use new MCP config on their next runtime build.",
      );
    });

  mcp
    .command("unset")
    .description("Remove one OpenClaw-managed MCP server")
    .argument("<name>", "MCP server name")
    .action(async (name: string) => {
      const result = await unsetMcpServer({ name });
      if (!result.ok) {
        fail(result.error);
      }
      if (!result.removed) {
        failUnknownMcpServer(name, result.path);
      }
      defaultRuntime.log(terminalText`Removed MCP server "${name}" from ${result.path}.`);
    });

  applyParentDefaultHelpAction(mcp);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
