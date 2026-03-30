import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import { assessGatewayExposureWarning } from "../gateway/gateway-exposure-warning.js";
import { resolveDmAllowState } from "../security/dm-policy-shared.js";
import { note } from "../terminal/note.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";

function collectImplicitHeartbeatDirectPolicyWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];

  const maybeWarn = (params: {
    label: string;
    heartbeat: AgentConfig["heartbeat"] | undefined;
    pathHint: string;
  }) => {
    const heartbeat = params.heartbeat;
    if (!heartbeat || heartbeat.target === undefined || heartbeat.target === "none") {
      return;
    }
    if (heartbeat.directPolicy !== undefined) {
      return;
    }
    warnings.push(
      `- ${params.label}: heartbeat delivery is configured while ${params.pathHint} is unset.`,
      '  Heartbeat now allows direct/DM targets by default. Set it explicitly to "allow" or "block" to pin upgrade behavior.',
    );
  };

  maybeWarn({
    label: "Heartbeat defaults",
    heartbeat: cfg.agents?.defaults?.heartbeat,
    pathHint: "agents.defaults.heartbeat.directPolicy",
  });

  for (const agent of cfg.agents?.list ?? []) {
    maybeWarn({
      label: `Heartbeat agent "${agent.id}"`,
      heartbeat: agent.heartbeat,
      pathHint: `heartbeat.directPolicy for agent "${agent.id}"`,
    });
  }

  return warnings;
}

export async function noteSecurityWarnings(cfg: OpenClawConfig): Promise<{
  hasCriticalGatewayExposure: boolean;
}> {
  const warnings: string[] = [];
  const auditHint = `- Run: ${formatCliCommand("openclaw security audit --deep")}`;

  if (cfg.approvals?.exec?.enabled === false) {
    warnings.push(
      "- Note: approvals.exec.enabled=false disables approval forwarding only.",
      "  Host exec gating still comes from ~/.openclaw/exec-approvals.json.",
      `  Check local policy with: ${formatCliCommand("openclaw approvals get --gateway")}`,
    );
  }

  warnings.push(...collectImplicitHeartbeatDirectPolicyWarnings(cfg));

  // ===========================================
  // GATEWAY NETWORK EXPOSURE CHECK
  // ===========================================
  // Check for dangerous gateway binding configurations
  // that expose the gateway to network without proper auth

  const gatewayExposure = assessGatewayExposureWarning({ cfg });
  if (gatewayExposure.isUnsafe) {
    warnings.push(
      `- CRITICAL: Gateway bound to "${gatewayExposure.bindHost}" without authentication. Anyone on your network can control your agent.`,
      `- Fix: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`,
      `- Fix: ${formatCliCommand("openclaw config set gateway.bind loopback")}`,
      "- Override (only if intentional): set OPENCLAW_SKIP_AUTH_WARNING=true",
    );
  }

  const warnDmPolicy = async (params: {
    label: string;
    provider: ChannelId;
    accountId: string;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const dmPolicy = params.dmPolicy;
    const policyPath = params.policyPath ?? `${params.allowFromPath}policy`;
    const { hasWildcard, allowCount, isMultiUserDm } = await resolveDmAllowState({
      provider: params.provider,
      accountId: params.accountId,
      allowFrom: params.allowFrom,
      normalizeEntry: params.normalizeEntry,
    });
    const dmScope = cfg.session?.dmScope ?? "main";

    if (dmPolicy === "open") {
      const allowFromPath = `${params.allowFromPath}allowFrom`;
      warnings.push(`- ${params.label} DMs: OPEN (${policyPath}="open"). Anyone can DM it.`);
      if (!hasWildcard) {
        warnings.push(
          `- ${params.label} DMs: config invalid — "open" requires ${allowFromPath} to include "*".`,
        );
      }
    }

    if (dmPolicy === "disabled") {
      warnings.push(`- ${params.label} DMs: disabled (${policyPath}="disabled").`);
      return;
    }

    if (dmPolicy !== "open" && allowCount === 0) {
      warnings.push(
        `- ${params.label} DMs: locked (${policyPath}="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`,
      );
      warnings.push(`  ${params.approveHint}`);
    }

    if (dmScope === "main" && isMultiUserDm) {
      warnings.push(
        `- ${params.label} DMs: multiple senders share the main session; run: ` +
          formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
          ' (or "per-account-channel-peer" for multi-account channels) to isolate sessions.',
      );
    }
  };

  for (const plugin of listChannelPlugins()) {
    if (!plugin.security) {
      continue;
    }
    const { defaultAccountId, account, enabled, configured, diagnostics } =
      await resolveDefaultChannelAccountContext(plugin, cfg, {
        mode: "read_only",
        commandName: "doctor",
      });
    for (const diagnostic of diagnostics) {
      warnings.push(`- [secrets] ${diagnostic}`);
    }
    if (!enabled) {
      continue;
    }
    if (!configured) {
      continue;
    }
    const dmPolicy = plugin.security.resolveDmPolicy?.({
      cfg,
      accountId: defaultAccountId,
      account,
    });
    if (dmPolicy) {
      await warnDmPolicy({
        label: plugin.meta.label ?? plugin.id,
        provider: plugin.id,
        accountId: defaultAccountId,
        dmPolicy: dmPolicy.policy,
        allowFrom: dmPolicy.allowFrom,
        policyPath: dmPolicy.policyPath,
        allowFromPath: dmPolicy.allowFromPath,
        approveHint: dmPolicy.approveHint,
        normalizeEntry: dmPolicy.normalizeEntry,
      });
    }
    if (plugin.security.collectWarnings) {
      const extra = await plugin.security.collectWarnings({
        cfg,
        accountId: defaultAccountId,
        account,
      });
      if (extra?.length) {
        warnings.push(...extra);
      }
    }
  }

  const lines = warnings.length > 0 ? warnings : ["- No channel security warnings detected."];
  lines.push(auditHint);
  note(lines.join("\n"), "Security");
  return {
    hasCriticalGatewayExposure: gatewayExposure.isUnsafe,
  };
}
