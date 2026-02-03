import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.js";
import type { SessionsListResult } from "../gateway/session-utils.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AgentSummary } from "./agents.config.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveAgentRuntimeKind } from "../agents/main-agent-runtime-factory.js";
import { formatCliCommand } from "../cli/command-format.js";
import { callGateway } from "../gateway/call.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { describeBinding } from "./agents.bindings.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { buildAgentSummaries } from "./agents.config.js";
import {
  buildProviderStatusIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";

type AgentsListOptions = {
  json?: boolean;
  bindings?: boolean;
  verbose?: boolean;
};

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [];
}

function resolveAgentModelConfig(cfg: OpenClawConfig, agentId: string) {
  const agent = resolveAgentConfig(cfg, agentId);
  const perAgent = agent?.model;
  const globalRaw = cfg.agents?.defaults?.model as
    | string
    | { primary?: string; fallbacks?: string[] }
    | undefined;

  const primary =
    (typeof perAgent === "string"
      ? perAgent.trim()
      : typeof perAgent === "object" && perAgent
        ? perAgent.primary?.trim()
        : "") ||
    (typeof globalRaw === "string"
      ? globalRaw.trim()
      : typeof globalRaw === "object" && globalRaw
        ? globalRaw.primary?.trim()
        : "") ||
    undefined;

  // Important: treat explicitly provided fallbacks: [] as an override to disable global fallbacks.
  const perAgentFallbacksOverride =
    typeof perAgent === "object" && perAgent && Object.hasOwn(perAgent, "fallbacks")
      ? Array.isArray(perAgent.fallbacks)
        ? perAgent.fallbacks
        : []
      : undefined;
  const globalFallbacks =
    typeof globalRaw === "object" && globalRaw && Array.isArray(globalRaw.fallbacks)
      ? globalRaw.fallbacks
      : undefined;

  const fallbacksRaw = perAgentFallbacksOverride ?? globalFallbacks;
  const fallbacks = fallbacksRaw ? (normalizeStringList(fallbacksRaw) ?? []) : undefined;

  if (!primary && fallbacks === undefined) {
    return undefined;
  }
  return { primary, fallbacks };
}

async function tryLoadGatewaySessionStats(cfg: OpenClawConfig, agentId: string) {
  const activeWindowMinutes = 60;
  try {
    const active = await callGateway<SessionsListResult>({
      config: cfg,
      method: "sessions.list",
      params: { agentId, activeMinutes: activeWindowMinutes },
      timeoutMs: 1200,
      suppressGatewayHealth: true,
    });
    const lastActivityAt =
      typeof active.sessions[0]?.updatedAt === "number"
        ? active.sessions[0].updatedAt
        : (() => {
            // No active sessions in the window - fall back to "most recent overall".
            // Keep this best-effort and fast.
            return null;
          })();
    let lastActivityResolved: number | undefined;
    if (typeof lastActivityAt === "number") {
      lastActivityResolved = lastActivityAt;
    } else {
      const last = await callGateway<SessionsListResult>({
        config: cfg,
        method: "sessions.list",
        params: { agentId, limit: 1 },
        timeoutMs: 1200,
        suppressGatewayHealth: true,
      });
      const resolved = last.sessions[0]?.updatedAt ?? null;
      if (typeof resolved === "number") {
        lastActivityResolved = resolved;
      }
    }
    return {
      activeSessions: active.count,
      activeWindowMinutes,
      lastActivityAt: lastActivityResolved,
    };
  } catch {
    return null;
  }
}

function formatSummary(summary: AgentSummary, opts: { verbose: boolean }) {
  const defaultTag = summary.isDefault ? " (default)" : "";
  const header =
    summary.name && summary.name !== summary.id
      ? `${summary.id}${defaultTag} (${summary.name})`
      : `${summary.id}${defaultTag}`;

  const identityParts = [];
  if (summary.identityEmoji) {
    identityParts.push(summary.identityEmoji);
  }
  if (summary.identityName) {
    identityParts.push(summary.identityName);
  }
  const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
  const identitySource =
    summary.identitySource === "identity"
      ? "IDENTITY.md"
      : summary.identitySource === "config"
        ? "config"
        : null;

  const lines = [`- ${header}`];
  if (identityLine) {
    lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
  }
  lines.push(
    `  Workspace: ${opts.verbose ? summary.workspace : shortenHomePath(summary.workspace)}`,
  );
  lines.push(`  Agent dir: ${opts.verbose ? summary.agentDir : shortenHomePath(summary.agentDir)}`);
  if (summary.model) {
    lines.push(`  Model: ${summary.model}`);
  }
  if (opts.verbose && summary.verbose?.model?.fallbacks) {
    const fallbacks = summary.verbose.model.fallbacks;
    lines.push(`  Model fallbacks: ${fallbacks.length > 0 ? fallbacks.join(", ") : "(none)"}`);
  }
  if (opts.verbose && summary.verbose?.runtime) {
    lines.push(`  Runtime: ${summary.verbose.runtime}`);
  }
  if (opts.verbose && (summary.verbose?.tools?.allow || summary.verbose?.tools?.deny)) {
    const allow = summary.verbose.tools?.allow;
    const deny = summary.verbose.tools?.deny;
    if (allow) {
      lines.push(`  Tools allow: ${allow.length > 0 ? allow.join(", ") : "(none)"}`);
    }
    if (deny) {
      lines.push(`  Tools deny: ${deny.length > 0 ? deny.join(", ") : "(none)"}`);
    }
  }
  if (
    opts.verbose &&
    (summary.verbose?.tools?.sandbox?.allow || summary.verbose?.tools?.sandbox?.deny)
  ) {
    const allow = summary.verbose.tools?.sandbox?.allow;
    const deny = summary.verbose.tools?.sandbox?.deny;
    if (allow) {
      lines.push(`  Sandbox tools allow: ${allow.length > 0 ? allow.join(", ") : "(none)"}`);
    }
    if (deny) {
      lines.push(`  Sandbox tools deny: ${deny.length > 0 ? deny.join(", ") : "(none)"}`);
    }
  }
  if (opts.verbose && summary.verbose?.sandbox?.mode) {
    const scope = summary.verbose.sandbox.scope ? ` scope=${summary.verbose.sandbox.scope}` : "";
    const access = summary.verbose.sandbox.workspaceAccess
      ? ` workspaceAccess=${summary.verbose.sandbox.workspaceAccess}`
      : "";
    lines.push(`  Sandbox: ${summary.verbose.sandbox.mode}${scope}${access}`);
  }
  if (opts.verbose && summary.verbose?.gateway) {
    const g = summary.verbose.gateway;
    const active =
      typeof g.activeSessions === "number" && typeof g.activeWindowMinutes === "number"
        ? `${g.activeSessions} (last ${g.activeWindowMinutes}m)`
        : null;
    const last =
      typeof g.lastActivityAt === "number" ? new Date(g.lastActivityAt).toISOString() : null;
    if (active) {
      lines.push(`  Active sessions: ${active}`);
    }
    if (last) {
      lines.push(`  Last activity: ${last}`);
    }
  }
  lines.push(`  Routing rules: ${summary.bindings}`);

  if (summary.routes?.length) {
    lines.push(`  Routing: ${summary.routes.join(", ")}`);
  }
  if (summary.providers?.length) {
    lines.push("  Providers:");
    for (const provider of summary.providers) {
      lines.push(`    - ${provider}`);
    }
  }

  if (summary.bindingDetails?.length) {
    lines.push("  Routing rules:");
    for (const binding of summary.bindingDetails) {
      lines.push(`    - ${binding}`);
    }
  }
  return lines.join("\n");
}

export async function agentsListCommand(
  opts: AgentsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const summaries = buildAgentSummaries(cfg);
  const bindingMap = new Map<string, AgentBinding[]>();
  for (const binding of cfg.bindings ?? []) {
    const agentId = normalizeAgentId(binding.agentId);
    const list = bindingMap.get(agentId) ?? [];
    list.push(binding);
    bindingMap.set(agentId, list);
  }

  if (opts.bindings) {
    for (const summary of summaries) {
      const bindings = bindingMap.get(summary.id) ?? [];
      if (bindings.length > 0) {
        summary.bindingDetails = bindings.map((binding) => describeBinding(binding));
      }
    }
  }

  const providerStatus = await buildProviderStatusIndex(cfg);

  for (const summary of summaries) {
    const bindings = bindingMap.get(summary.id) ?? [];
    const routes = summarizeBindings(cfg, bindings);
    if (routes.length > 0) {
      summary.routes = routes;
    } else if (summary.isDefault) {
      summary.routes = ["default (no explicit rules)"];
    }

    const providerLines = listProvidersForAgent({
      summaryIsDefault: summary.isDefault,
      cfg,
      bindings,
      providerStatus,
    });
    if (providerLines.length > 0) {
      summary.providers = providerLines;
    }
  }

  if (opts.verbose) {
    // Populate extra details only when requested to preserve JSON stability.
    const gatewayStatsByAgent = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof tryLoadGatewaySessionStats>>>
    >();
    let gatewayChecked = false;
    let gatewayAvailable = false;

    for (const summary of summaries) {
      const agentCfg = resolveAgentConfig(cfg, summary.id);
      const modelCfg = resolveAgentModelConfig(cfg, summary.id);
      const runtimeKind = resolveAgentRuntimeKind(cfg, summary.id);
      const toolsAllow = normalizeStringList(agentCfg?.tools?.allow);
      const toolsDeny = normalizeStringList(agentCfg?.tools?.deny);
      const sandboxToolsAllow = normalizeStringList(agentCfg?.tools?.sandbox?.tools?.allow);
      const sandboxToolsDeny = normalizeStringList(agentCfg?.tools?.sandbox?.tools?.deny);

      const defaultsSandbox = cfg.agents?.defaults?.sandbox;
      const rawSandbox = agentCfg?.sandbox;
      const sandboxMode = rawSandbox?.mode ?? defaultsSandbox?.mode;
      const sandboxScope =
        rawSandbox?.scope ??
        (typeof rawSandbox?.perSession === "boolean"
          ? rawSandbox.perSession
            ? "session"
            : "shared"
          : undefined) ??
        defaultsSandbox?.scope ??
        (typeof defaultsSandbox?.perSession === "boolean"
          ? defaultsSandbox.perSession
            ? "session"
            : "shared"
          : undefined);
      const sandboxWorkspaceAccess =
        rawSandbox?.workspaceAccess ?? defaultsSandbox?.workspaceAccess;

      if (!summary.verbose) {
        summary.verbose = {};
      }
      summary.verbose.model = modelCfg;
      summary.verbose.runtime = runtimeKind;
      if (toolsAllow || toolsDeny || sandboxToolsAllow || sandboxToolsDeny) {
        summary.verbose.tools = {
          ...(toolsAllow ? { allow: toolsAllow } : {}),
          ...(toolsDeny ? { deny: toolsDeny } : {}),
          ...(sandboxToolsAllow || sandboxToolsDeny
            ? {
                sandbox: {
                  ...(sandboxToolsAllow ? { allow: sandboxToolsAllow } : {}),
                  ...(sandboxToolsDeny ? { deny: sandboxToolsDeny } : {}),
                },
              }
            : {}),
        };
      }
      const sandboxConfigured =
        rawSandbox !== undefined ||
        (defaultsSandbox !== undefined && Object.keys(defaultsSandbox).length > 0);
      if (sandboxConfigured && (sandboxMode || sandboxScope || sandboxWorkspaceAccess)) {
        summary.verbose.sandbox = {
          ...(sandboxMode ? { mode: sandboxMode } : {}),
          ...(sandboxScope ? { scope: sandboxScope } : {}),
          ...(sandboxWorkspaceAccess ? { workspaceAccess: sandboxWorkspaceAccess } : {}),
        };
      }

      // Gateway session stats (best-effort; only when gateway is reachable).
      if (!gatewayChecked) {
        gatewayChecked = true;
        const stats = await tryLoadGatewaySessionStats(cfg, summary.id);
        if (stats) {
          gatewayAvailable = true;
          gatewayStatsByAgent.set(summary.id, stats);
        }
      } else if (gatewayAvailable) {
        const stats = await tryLoadGatewaySessionStats(cfg, summary.id);
        if (stats) {
          gatewayStatsByAgent.set(summary.id, stats);
        }
      }
    }

    for (const summary of summaries) {
      const stats = gatewayStatsByAgent.get(summary.id);
      if (stats) {
        summary.verbose = {
          ...(summary.verbose ?? {}),
          gateway: stats,
        };
      }
    }
  }

  if (opts.json) {
    runtime.log(JSON.stringify(summaries, null, 2));
    return;
  }

  const lines = [
    "Agents:",
    ...summaries.map((summary) => formatSummary(summary, { verbose: opts.verbose === true })),
  ];
  lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
  lines.push(
    `Channel status reflects local config/creds. For live health: ${formatCliCommand("openclaw channels status --probe")}.`,
  );
  runtime.log(lines.join("\n"));
}
