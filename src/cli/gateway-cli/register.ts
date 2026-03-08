import fs from "node:fs/promises";
import type { Command } from "commander";
import { gatewayStatusCommand } from "../../commands/gateway-status.js";
import { formatHealthChannelLines, type HealthSummary } from "../../commands/health.js";
import { loadConfig } from "../../config/config.js";
import { discoverGatewayBeacons } from "../../infra/bonjour-discovery.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import { resolveWideAreaDiscoveryDomain } from "../../infra/widearea-dns.js";
import { defaultRuntime } from "../../runtime.js";
import { styleHealthChannelLine } from "../../terminal/health-style.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayServiceCommands } from "../daemon-cli.js";
import { formatHelpExamples } from "../help-format.js";
import { withProgress } from "../progress.js";
import { callGatewayCli, gatewayCallOpts } from "./call.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import {
  dedupeBeacons,
  parseDiscoverTimeoutMs,
  pickBeaconHost,
  pickGatewayPort,
  renderBeaconLines,
} from "./discover.js";
import { addGatewayRunCommand } from "./run.js";

function runGatewayCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function parseDaysOption(raw: unknown, fallback = 30): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

type GatewayUserRole = "admin" | "member";

type GatewayUserInput = {
  id: string;
  displayName: string;
  role?: GatewayUserRole;
  allowedAgentIds?: string[];
  allowedChannels?: string[];
  toolAllow?: string[];
  toolDeny?: string[];
};

type GatewayUserRow = GatewayUserInput & {
  enabled?: boolean;
  primaryAgentId?: string;
};

function normalizeCsvOption(value: unknown): string[] | undefined {
  const raw = typeof value === "string" ? value : "";
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function normalizeGatewayUserRole(value: unknown): GatewayUserRole | undefined {
  if (value === "admin") {
    return "admin";
  }
  if (value === "member") {
    return "member";
  }
  return undefined;
}

function readTrimmedScalarString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString().trim();
  }
  return "";
}

function sanitizeGatewayUserInput(value: unknown): GatewayUserInput | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = readTrimmedScalarString(entry.id);
  const displayName = readTrimmedScalarString(entry.displayName);
  if (!id || !displayName) {
    return null;
  }
  const allowedAgentIds = Array.isArray(entry.allowedAgentIds)
    ? entry.allowedAgentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
    : undefined;
  const allowedChannels = Array.isArray(entry.allowedChannels)
    ? entry.allowedChannels.map((item) => String(item ?? "").trim()).filter(Boolean)
    : undefined;
  const toolAllow = Array.isArray(entry.toolAllow)
    ? entry.toolAllow.map((item) => String(item ?? "").trim()).filter(Boolean)
    : undefined;
  const toolDeny = Array.isArray(entry.toolDeny)
    ? entry.toolDeny.map((item) => String(item ?? "").trim()).filter(Boolean)
    : undefined;
  return {
    id,
    displayName,
    role: normalizeGatewayUserRole(entry.role),
    allowedAgentIds: allowedAgentIds && allowedAgentIds.length > 0 ? allowedAgentIds : undefined,
    allowedChannels: allowedChannels && allowedChannels.length > 0 ? allowedChannels : undefined,
    toolAllow: toolAllow && toolAllow.length > 0 ? toolAllow : undefined,
    toolDeny: toolDeny && toolDeny.length > 0 ? toolDeny : undefined,
  };
}

function parseGatewayUsersFile(value: unknown): GatewayUserInput[] {
  const rawUsers = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { users?: unknown[] }).users)
      ? (value as { users: unknown[] }).users
      : null;
  if (!rawUsers) {
    throw new Error('Expected JSON array or object with "users" array');
  }
  const users = rawUsers
    .map((entry) => sanitizeGatewayUserInput(entry))
    .filter((entry) => Boolean(entry));
  if (users.length === 0) {
    throw new Error("No valid users found in file");
  }
  return users as GatewayUserInput[];
}

function buildGatewayUserRpcPayload(params: {
  id: string;
  displayName?: string;
  role?: GatewayUserRole;
  enabled?: boolean;
  allowedAgentIds?: string[];
  allowedChannels?: string[];
  toolAllow?: string[];
  toolDeny?: string[];
}): Record<string, unknown> {
  return {
    id: params.id,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(typeof params.enabled === "boolean" ? { enabled: params.enabled } : {}),
    ...(params.allowedAgentIds ? { allowedAgentIds: params.allowedAgentIds } : {}),
    ...(params.allowedChannels ? { allowedChannels: params.allowedChannels } : {}),
    ...(params.toolAllow ? { toolAllow: params.toolAllow } : {}),
    ...(params.toolDeny ? { toolDeny: params.toolDeny } : {}),
  };
}

function renderGatewayUsersList(users: GatewayUserRow[], rich: boolean): string[] {
  const lines = [colorize(rich, theme.heading, "Gateway Users")];
  if (users.length === 0) {
    lines.push(colorize(rich, theme.muted, "No users configured"));
    return lines;
  }
  for (const user of users) {
    const role = user.role ?? "member";
    const enabled = user.enabled === false ? "disabled" : "enabled";
    const agent = user.primaryAgentId ?? "(auto)";
    const channels =
      Array.isArray(user.allowedChannels) && user.allowedChannels.length > 0
        ? user.allowedChannels.join(", ")
        : "any";
    lines.push(`${user.id} · ${user.displayName} · ${role} · ${enabled}`);
    lines.push(`${colorize(rich, theme.muted, "  agent:")} ${agent}`);
    lines.push(`${colorize(rich, theme.muted, "  channels:")} ${channels}`);
  }
  return lines;
}

function resolveGatewayRpcOptions<T extends { token?: string; password?: string }>(
  opts: T,
  command?: Command,
): T {
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentPassword = inheritOptionFromParent<string>(command, "password");
  return {
    ...opts,
    token: opts.token ?? parentToken,
    password: opts.password ?? parentPassword,
  };
}

function renderCostUsageSummary(summary: CostUsageSummary, days: number, rich: boolean): string[] {
  const totalCost = formatUsd(summary.totals.totalCost) ?? "$0.00";
  const totalTokens = formatTokenCount(summary.totals.totalTokens) ?? "0";
  const lines = [
    colorize(rich, theme.heading, `Usage cost (${days} days)`),
    `${colorize(rich, theme.muted, "Total:")} ${totalCost} · ${totalTokens} tokens`,
  ];

  if (summary.totals.missingCostEntries > 0) {
    lines.push(
      `${colorize(rich, theme.muted, "Missing entries:")} ${summary.totals.missingCostEntries}`,
    );
  }

  const latest = summary.daily.at(-1);
  if (latest) {
    const latestCost = formatUsd(latest.totalCost) ?? "$0.00";
    const latestTokens = formatTokenCount(latest.totalTokens) ?? "0";
    lines.push(
      `${colorize(rich, theme.muted, "Latest day:")} ${latest.date} · ${latestCost} · ${latestTokens} tokens`,
    );
  }

  return lines;
}

export function registerGatewayCli(program: Command) {
  const gateway = addGatewayRunCommand(
    program
      .command("gateway")
      .description("Run, inspect, and query the WebSocket Gateway")
      .addHelpText(
        "after",
        () =>
          `\n${theme.heading("Examples:")}\n${formatHelpExamples([
            ["openclaw gateway run", "Run the gateway in the foreground."],
            ["openclaw gateway status", "Show service status and probe reachability."],
            ["openclaw gateway discover", "Find local and wide-area gateway beacons."],
            ["openclaw gateway call health", "Call a gateway RPC method directly."],
          ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  addGatewayServiceCommands(gateway, {
    statusDescription: "Show gateway service status + probe the Gateway",
  });

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument("<method>", "Method name (health/status/system-presence/cron.*)")
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, rpcOpts, params);
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`,
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "Gateway call failed");
      }),
  );

  const usersCommand = gateway
    .command("users")
    .description("Manage gateway users with isolated workspaces and message histories");

  gatewayCallOpts(
    usersCommand
      .command("list")
      .description("List configured gateway users")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const result = (await callGatewayCli("users.list", rpcOpts, {})) as {
            users?: GatewayUserRow[];
          };
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const users = Array.isArray(result?.users) ? result.users : [];
          const rich = isRich();
          for (const line of renderGatewayUsersList(users, rich)) {
            defaultRuntime.log(line);
          }
        }, "Gateway users list failed");
      }),
  );

  gatewayCallOpts(
    usersCommand
      .command("create")
      .description("Create one gateway user")
      .requiredOption("--id <id>", "User id")
      .requiredOption("--name <displayName>", "Display name")
      .option("--role <role>", "Role: member|admin", "member")
      .option("--allowed-agents <csv>", "Comma-separated allowed agent ids")
      .option("--allowed-channels <csv>", "Comma-separated allowed channels")
      .option("--tool-allow <csv>", "Comma-separated allowed tool names")
      .option("--tool-deny <csv>", "Comma-separated denied tool names")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const role = normalizeGatewayUserRole(opts.role);
          if (!role) {
            throw new Error('Invalid role. Use "member" or "admin".');
          }
          const result = await callGatewayCli(
            "users.create",
            rpcOpts,
            buildGatewayUserRpcPayload({
              id: String(opts.id ?? "").trim(),
              displayName: String(opts.name ?? "").trim(),
              role,
              allowedAgentIds: normalizeCsvOption(opts.allowedAgents),
              allowedChannels: normalizeCsvOption(opts.allowedChannels),
              toolAllow: normalizeCsvOption(opts.toolAllow),
              toolDeny: normalizeCsvOption(opts.toolDeny),
            }),
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "Gateway users create failed");
      }),
  );

  gatewayCallOpts(
    usersCommand
      .command("update")
      .description("Update one gateway user")
      .requiredOption("--id <id>", "User id")
      .option("--name <displayName>", "Display name")
      .option("--role <role>", "Role: member|admin")
      .option("--enabled <enabled>", "true|false")
      .option("--allowed-agents <csv>", "Comma-separated allowed agent ids")
      .option("--allowed-channels <csv>", "Comma-separated allowed channels")
      .option("--tool-allow <csv>", "Comma-separated allowed tool names")
      .option("--tool-deny <csv>", "Comma-separated denied tool names")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const role = opts.role ? normalizeGatewayUserRole(opts.role) : undefined;
          if (opts.role && !role) {
            throw new Error('Invalid role. Use "member" or "admin".');
          }
          const enabled =
            typeof opts.enabled === "string"
              ? opts.enabled.trim().toLowerCase() === "true"
                ? true
                : opts.enabled.trim().toLowerCase() === "false"
                  ? false
                  : undefined
              : undefined;
          if (typeof opts.enabled === "string" && enabled === undefined) {
            throw new Error('Invalid --enabled value. Use "true" or "false".');
          }
          const result = await callGatewayCli(
            "users.update",
            rpcOpts,
            buildGatewayUserRpcPayload({
              id: String(opts.id ?? "").trim(),
              displayName: typeof opts.name === "string" ? opts.name.trim() : undefined,
              role,
              enabled,
              allowedAgentIds: normalizeCsvOption(opts.allowedAgents),
              allowedChannels: normalizeCsvOption(opts.allowedChannels),
              toolAllow: normalizeCsvOption(opts.toolAllow),
              toolDeny: normalizeCsvOption(opts.toolDeny),
            }),
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "Gateway users update failed");
      }),
  );

  gatewayCallOpts(
    usersCommand
      .command("delete")
      .description("Delete one gateway user")
      .requiredOption("--id <id>", "User id")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const result = await callGatewayCli("users.delete", rpcOpts, {
            id: String(opts.id ?? "").trim(),
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "Gateway users delete failed");
      }),
  );

  gatewayCallOpts(
    usersCommand
      .command("token-reset")
      .description("Rotate one gateway user token")
      .requiredOption("--id <id>", "User id")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const result = await callGatewayCli("users.token.reset", rpcOpts, {
            id: String(opts.id ?? "").trim(),
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        }, "Gateway users token reset failed");
      }),
  );

  gatewayCallOpts(
    usersCommand
      .command("apply")
      .description("Create or update many users from JSON file")
      .requiredOption("--file <path>", "Path to users JSON file")
      .option("--upsert", "Update existing users instead of skipping", false)
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const raw = await fs.readFile(String(opts.file), "utf-8");
          const desiredUsers = parseGatewayUsersFile(JSON.parse(raw));
          const listed = (await callGatewayCli("users.list", rpcOpts, {})) as {
            users?: GatewayUserRow[];
          };
          const existingIds = new Set(
            (Array.isArray(listed?.users) ? listed.users : [])
              .map((entry) => String(entry.id ?? "").trim())
              .filter(Boolean),
          );
          const created: string[] = [];
          const updated: string[] = [];
          const skipped: string[] = [];
          for (const user of desiredUsers) {
            const exists = existingIds.has(user.id);
            if (exists && !opts.upsert) {
              skipped.push(user.id);
              continue;
            }
            const method = exists ? "users.update" : "users.create";
            await callGatewayCli(
              method,
              { ...rpcOpts, json: true },
              buildGatewayUserRpcPayload({
                id: user.id,
                displayName: user.displayName,
                role: user.role,
                allowedAgentIds: user.allowedAgentIds,
                allowedChannels: user.allowedChannels,
                toolAllow: user.toolAllow,
                toolDeny: user.toolDeny,
              }),
            );
            if (exists) {
              updated.push(user.id);
            } else {
              created.push(user.id);
            }
          }
          const summary = { total: desiredUsers.length, created, updated, skipped };
          defaultRuntime.log(JSON.stringify(summary, null, 2));
        }, "Gateway users apply failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("usage-cost")
      .description("Fetch usage cost summary from session logs")
      .option("--days <days>", "Number of days to include", "30")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const days = parseDaysOption(opts.days);
          const result = await callGatewayCli("usage.cost", rpcOpts, { days });
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const summary = result as CostUsageSummary;
          for (const line of renderCostUsageSummary(summary, days, rich)) {
            defaultRuntime.log(line);
          }
        }, "Gateway usage cost failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const result = await callGatewayCli("health", rpcOpts);
          if (rpcOpts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const obj: Record<string, unknown> = result && typeof result === "object" ? result : {};
          const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : null;
          defaultRuntime.log(colorize(rich, theme.heading, "Gateway Health"));
          defaultRuntime.log(
            `${colorize(rich, theme.success, "OK")}${durationMs != null ? ` (${durationMs}ms)` : ""}`,
          );
          if (obj.channels && typeof obj.channels === "object") {
            for (const line of formatHealthChannelLines(obj as HealthSummary)) {
              defaultRuntime.log(styleHealthChannelLine(line, rich));
            }
          }
        });
      }),
  );

  gateway
    .command("probe")
    .description("Show gateway reachability + discovery + health + status summary (local + remote)")
    .option("--url <url>", "Explicit Gateway WebSocket URL (still probes localhost)")
    .option("--ssh <target>", "SSH target for remote gateway tunnel (user@host or user@host:port)")
    .option("--ssh-identity <path>", "SSH identity file path")
    .option("--ssh-auto", "Try to derive an SSH target from Bonjour discovery", false)
    .option("--token <token>", "Gateway token (applies to all probes)")
    .option("--password <password>", "Gateway password (applies to all probes)")
    .option("--timeout <ms>", "Overall probe budget in ms", "3000")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await runGatewayCommand(async () => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        await gatewayStatusCommand(rpcOpts, defaultRuntime);
      });
    });

  gateway
    .command("discover")
    .description("Discover gateways via Bonjour (local + wide-area if configured)")
    .option("--timeout <ms>", "Per-command timeout in ms", "2000")
    .option("--json", "Output JSON", false)
    .action(async (opts: GatewayDiscoverOpts) => {
      await runGatewayCommand(async () => {
        const cfg = loadConfig();
        const wideAreaDomain = resolveWideAreaDiscoveryDomain({
          configDomain: cfg.discovery?.wideArea?.domain,
        });
        const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2000);
        const domains = ["local.", ...(wideAreaDomain ? [wideAreaDomain] : [])];
        const beacons = await withProgress(
          {
            label: "Scanning for gateways…",
            indeterminate: true,
            enabled: opts.json !== true,
            delayMs: 0,
          },
          async () => await discoverGatewayBeacons({ timeoutMs, wideAreaDomain }),
        );

        const deduped = dedupeBeacons(beacons).toSorted((a, b) =>
          String(a.displayName || a.instanceName).localeCompare(
            String(b.displayName || b.instanceName),
          ),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return { ...b, wsUrl: host ? `ws://${host}:${port}` : null };
          });
          defaultRuntime.log(
            JSON.stringify(
              {
                timeoutMs,
                domains,
                count: enriched.length,
                beacons: enriched,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Gateway Discovery"));
        defaultRuntime.log(
          colorize(
            rich,
            theme.muted,
            `Found ${deduped.length} gateway(s) · domains: ${domains.join(", ")}`,
          ),
        );
        if (deduped.length === 0) {
          return;
        }

        for (const beacon of deduped) {
          for (const line of renderBeaconLines(beacon, rich)) {
            defaultRuntime.log(line);
          }
        }
      }, "gateway discover failed");
    });
}
