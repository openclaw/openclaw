import type { ToolsEffectiveResult } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  listAgentIds,
  resolveConfiguredAgentId,
  resolveSoleAgentId,
} from "../agents/agent-scope-config.js";
import {
  resolveConfiguredToolAccess,
  type ToolAccessDiagnostics,
} from "../agents/tool-access-diagnostics.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeExecApprovalDisplayText } from "../infra/exec-approval-text-sanitize.js";
import { SESSION_EXEC_OVERRIDES_NOTE } from "../infra/exec-approvals-effective.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCliWithTransport, type GatewayRpcOpts } from "./gateway-rpc.js";

const TERMINAL_TOOLS = ["exec", "process"] as const;

export type ExecPolicyShowOptions = GatewayRpcOpts & {
  agent?: string;
  session?: string;
  verbose?: boolean;
};

export type ExecPolicyToolAccess = {
  agentId?: string;
  sessionKey?: string;
  local?: ToolAccessDiagnostics;
  // "verified" means the Gateway preview was retrieved, not that execution was proven.
  live?:
    | { status: "verified"; diagnostics: ToolAccessDiagnostics }
    | { status: "unverified"; error: string };
};

export async function buildExecPolicyToolAccess(
  config: OpenClawConfig,
  options: ExecPolicyShowOptions,
): Promise<ExecPolicyToolAccess> {
  const requestedAgent = options.agent?.trim();
  const sessionKey = options.session?.trim();
  if (options.agent !== undefined && !requestedAgent) {
    throw new Error("--agent must not be blank.");
  }
  if (options.session !== undefined && !sessionKey) {
    throw new Error("--session must not be blank.");
  }
  const sessionAgent = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  const explicitAgent = requestedAgent ? normalizeAgentId(requestedAgent) : undefined;
  if (explicitAgent && sessionAgent && explicitAgent !== sessionAgent) {
    throw new Error(`Agent "${explicitAgent}" does not match session agent "${sessionAgent}".`);
  }
  const agentId = sessionKey
    ? (explicitAgent ?? sessionAgent)
    : resolveConfiguredAgentId(
        config,
        explicitAgent ??
          resolveSoleAgentId(config, {
            surface: "exec-policy show",
            hint: "Pass --agent <id> or --session <agent session key>.",
          }),
      );
  const access: ExecPolicyToolAccess = {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
  if (sessionKey) {
    try {
      const result = await callGatewayFromCliWithTransport<ToolsEffectiveResult>(
        "tools.effective",
        options,
        { ...(agentId ? { agentId } : {}), sessionKey },
        { progress: false, sharedStateMode: "read-only" },
      );
      if (agentId && result.agentId !== agentId) {
        throw new Error("The Gateway returned tool access for a different agent.");
      }
      access.agentId = result.agentId;
      access.live = {
        status: "verified",
        diagnostics: result.toolAccess ?? describeLegacySessionPreview(result),
      };
    } catch (error) {
      access.live = {
        status: "unverified",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (access.agentId && listAgentIds(config).includes(access.agentId)) {
    access.local = resolveConfiguredToolAccess({
      config,
      agentId: access.agentId,
      toolNames: TERMINAL_TOOLS,
    });
  }
  return access;
}

function describeLegacySessionPreview(result: ToolsEffectiveResult): ToolAccessDiagnostics {
  const tools = result.groups.flatMap((group) => group.tools);
  return {
    checked: "live-session",
    profiles: [],
    tools: TERMINAL_TOOLS.map((id) => {
      const entry = tools.find((tool) => tool.id === id);
      return {
        id,
        status: entry?.deniedBySession ? "excluded" : entry ? "available" : "unavailable",
        reasons: entry?.deniedBySession
          ? [{ kind: "session", label: "Denied by this session's tool restrictions" }]
          : entry
            ? []
            : [{ kind: "runtime", label: "Not included in the session preview" }],
      };
    }),
  };
}

function display(value: string): string {
  return sanitizeExecApprovalDisplayText(sanitizeTerminalText(value));
}

function terminalTools(diagnostics: ToolAccessDiagnostics) {
  return diagnostics.tools.filter((tool) => TERMINAL_TOOLS.some((id) => id === tool.id));
}

function isExcluded(tool: ToolAccessDiagnostics["tools"][number]): boolean {
  return tool.status === "excluded";
}

type CommandApprovalSummary = {
  scopeLabel?: string;
  host: { requested: string };
  security: { effective: string };
  ask: { effective: string };
  askFallback: { effective: string };
};

export function formatExecPolicyCommandApprovals(params: {
  scopes: readonly CommandApprovalSummary[];
  approvalsExists: boolean;
  showScopeLabels?: boolean;
}): string[] {
  const lines = params.scopes.map((approval) => {
    const ask =
      approval.ask.effective === "on-miss"
        ? "ask on miss"
        : approval.ask.effective === "always"
          ? "always ask"
          : approval.ask.effective === "off"
            ? "no approval prompts"
            : "approval mode unknown";
    const label = params.showScopeLabels && approval.scopeLabel ? `${approval.scopeLabel}: ` : "";
    return display(
      `${label}${approval.host.requested} · ${approval.security.effective} · ${ask} · fallback ${approval.askFallback.effective}`,
    );
  });
  if (!params.approvalsExists) {
    lines.push("Approvals State: defaults (no stored overrides)");
  }
  lines.push("Command approvals do not grant tool access.", SESSION_EXEC_OVERRIDES_NOTE);
  return lines;
}

export function renderExecPolicyToolAccess(params: {
  access: ExecPolicyToolAccess;
  approvals?: CommandApprovalSummary;
  approvalsExists: boolean;
  verbose?: boolean;
}): void {
  const { access } = params;
  const rich = isRich();
  const heading = (value: string) => (rich ? theme.heading(value) : value);
  const preview = access.live?.status === "verified" ? access.live.diagnostics : undefined;
  const diagnostics = preview ?? access.local;
  const tools = diagnostics ? terminalTools(diagnostics) : [];
  const excluded = tools.filter(isExcluded);
  const missingFromPreview = tools.some((tool) => tool.status === "unavailable");
  const status =
    access.live?.status === "unverified"
      ? "UNVERIFIED"
      : excluded.length === TERMINAL_TOOLS.length
        ? preview
          ? "BLOCKED"
          : "OFF"
        : excluded.length > 0
          ? "PARTIAL"
          : preview
            ? "PREVIEW"
            : "UNVERIFIED";
  const lines = [
    heading(`TERMINAL ACCESS · ${display(access.agentId ?? "unknown agent")} — ${status}`),
  ];
  if (access.sessionKey) {
    lines.push(`Session: ${display(access.sessionKey)}`);
  }
  const section = (title: string) => {
    lines.push("", heading(`── ${title} ${"─".repeat(Math.max(1, 43 - title.length))}`), "");
  };
  if (diagnostics && diagnostics.profiles.length > 0) {
    section(preview ? "PROFILE (GATEWAY CONFIGURATION)" : "PROFILE");
    const global = diagnostics.profiles.find((profile) => profile.source === "tools.profile");
    const agent = diagnostics.profiles.find(
      (profile) =>
        profile.source.startsWith("agents.") && profile.source.endsWith(".tools.profile"),
    );
    const profileText = (profile: ToolAccessDiagnostics["profiles"][number]) =>
      `${display(profile.profile)}${profile.active ? " ← active" : ""}`;
    if (global) {
      lines.push(`Global: ${profileText(global)}`);
    }
    if (agent) {
      lines.push(`${global ? "└─ " : ""}Agent: ${profileText(agent)}`);
    }
    for (const profile of diagnostics.profiles.filter(
      (candidate) => candidate !== global && candidate !== agent,
    )) {
      lines.push(`${display(profile.source)}: ${profileText(profile)}`);
    }
  }
  section("CHECK RESULTS");
  if (!access.local) {
    lines.push("Local tool policy: unavailable — no matching local agent.");
  }
  if (access.live?.status === "unverified") {
    if (access.local) {
      const localExcluded = terminalTools(access.local).filter(isExcluded);
      lines.push(
        localExcluded.length > 0
          ? `Local configuration excludes: ${localExcluded.map((tool) => tool.id).join(", ")}`
          : "Local configuration allows terminal tools; execution unverified",
      );
    }
    lines.push(`Session preview: could not retrieve — ${display(access.live.error)}`);
  }
  for (const tool of tools) {
    const label =
      tool.status === "available"
        ? "Included in session preview"
        : tool.status === "allowed"
          ? "Allowed by configuration; execution unverified"
          : isExcluded(tool)
            ? "Excluded by policy"
            : "Not included in session preview; execution unverified";
    lines.push(`${display(tool.id)}: ${label}`);
    for (const reason of tool.reasons) {
      lines.push(
        `  ${display(reason.label)}${reason.source ? ` (${display(reason.source)})` : ""}`,
      );
    }
  }
  if (diagnostics) {
    lines.push(
      "",
      `Based on: ${preview ? "session preview (saved settings)" : "local configuration"}`,
    );
  }
  if (preview) {
    lines.push("Session preview uses saved settings; active runs may differ.");
  }
  section("COMMAND APPROVALS (LOCAL)");
  lines.push(
    ...formatExecPolicyCommandApprovals({
      scopes: params.approvals ? [params.approvals] : [],
      approvalsExists: params.approvalsExists,
    }),
  );
  section("NEXT STEP");
  if (access.live?.status === "unverified") {
    lines.push("Check the Gateway connection and session key, then retry.");
  } else if (excluded.length > 0) {
    const additions = new Map<string, string[]>();
    const canSuggest = !missingFromPreview && excluded.every((tool) => tool.alsoAllowPath);
    if (canSuggest) {
      for (const tool of excluded) {
        const path = tool.alsoAllowPath!;
        additions.set(path, [...(additions.get(path) ?? []), tool.id]);
      }
      lines.push("If terminal access is intended, append:");
      for (const [path, ids] of additions) {
        lines.push(`  ${ids.join(", ")}`, "to:", `  ${display(path)}`);
      }
      lines.push(
        "",
        "Preserve existing entries and command approvals.",
        "Inspect the session preview, then verify execution in a run.",
      );
    } else {
      lines.push("Review the policy exclusions listed above before enabling terminal access.");
    }
  } else if (preview) {
    lines.push(
      missingFromPreview
        ? "Missing preview tools are not necessarily disabled."
        : "Preview inclusion does not guarantee execution.",
      "Verify execution in a run; command approvals still apply.",
    );
  } else {
    lines.push("Inspect an existing session's tool preview:");
    lines.push("  openclaw exec-policy show --session <session-key>");
    lines.push("Verify execution in a run; command approvals still apply.");
  }
  if (preview && missingFromPreview && excluded.length > 0) {
    lines.push("Missing preview tools are not necessarily disabled; verify execution in a run.");
  }
  if (params.verbose) {
    section("TOOL POLICY SOURCES");
    for (const profile of diagnostics?.profiles ?? []) {
      lines.push(`${display(profile.source)} = ${display(profile.profile)}`);
    }
  } else {
    lines.push("", "Use --verbose for policy sources and all command approval scopes.");
  }
  defaultRuntime.log(lines.join("\n"));
}
