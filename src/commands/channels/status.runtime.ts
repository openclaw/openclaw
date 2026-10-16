// Runtime-only rendering and config fallback for `openclaw channels status`.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { getConfiguredChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { collectChannelStatusIssues } from "../../infra/channels-status-issues.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { formatPhoneNumberForCli } from "../../infra/phone-number-presentation.js";
import { listConfiguredAnnounceChannelIdsForConfig } from "../../plugins/channel-plugin-ids.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { requireValidConfig } from "../config-validation.js";
import {
  appendBaseUrlBit,
  appendEnabledConfiguredLinkedBits,
  appendModeBit,
  appendTokenSourceBits,
  buildChannelAccountLine,
  type ChatChannel,
  NO_CONFIGURED_CHAT_CHANNELS_LINE,
} from "./shared.js";
import { formatConfigChannelsStatusLines } from "./status-config-format.js";
import type { ChannelsStatusOptions } from "./status.js";

function formatEventLoopBits(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.degraded !== true) {
    return null;
  }
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const delayMaxMs = asFiniteNumber(record.delayMaxMs);
  const utilization = asFiniteNumber(record.utilization);
  const cpuCoreRatio = asFiniteNumber(record.cpuCoreRatio);
  const degradedSinceMs = asFiniteNumber(record.degradedSinceMs);
  const delayP99Ms = asFiniteNumber(record.delayP99Ms);
  return [
    degradedSinceMs != null
      ? `for ${formatDurationCompact(Math.max(0, degradedSinceMs)) ?? "0s"}`
      : null,
    delayP99Ms != null ? `(p99 ${Math.round(delayP99Ms)}ms)` : null,
    reasons.length ? `reasons=${reasons.join(",")}` : null,
    delayMaxMs != null ? `eventLoopDelayMaxMs=${Math.round(delayMaxMs)}` : null,
    utilization != null ? `eventLoopUtilization=${utilization}` : null,
    cpuCoreRatio != null ? `cpuCoreRatio=${cpuCoreRatio}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/** Render gateway channel status payloads into terminal-friendly lines. */
export function formatGatewayChannelsStatusLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(theme.success("Gateway reachable."));
  const eventLoopLine = formatEventLoopBits(payload.eventLoop);
  if (eventLoopLine) {
    lines.push(theme.warn(`Gateway event loop degraded ${eventLoopLine}`));
  }
  const statusWarnings = Array.isArray(payload.warnings)
    ? payload.warnings
        .filter(
          (warning): warning is string => typeof warning === "string" && warning.trim().length > 0,
        )
        .slice(0, 50)
    : [];
  if (payload.partial === true || statusWarnings.length > 0) {
    lines.push(theme.warn("Channel status is partial:"));
    for (const warning of statusWarnings) {
      lines.push(`- ${warning.slice(0, 500)}`);
    }
    lines.push("");
  }
  const channelLabels =
    payload.channelLabels && typeof payload.channelLabels === "object"
      ? (payload.channelLabels as Record<string, unknown>)
      : {};
  const accountLines = (provider: ChatChannel, accounts: Array<Record<string, unknown>>) =>
    accounts.map((account) => {
      const bits: string[] = [];
      appendEnabledConfiguredLinkedBits(bits, account);
      if (typeof account.running === "boolean") {
        bits.push(account.running ? "running" : "stopped");
      }
      if (typeof account.connected === "boolean") {
        bits.push(account.connected ? "connected" : "disconnected");
      }
      for (const [key, label] of [
        ["lastInboundAt", "in"],
        ["lastOutboundAt", "out"],
        ["lastTransportActivityAt", "transport"],
      ] as const) {
        const timestamp = asFiniteNumber(account[key]);
        if (timestamp) {
          bits.push(`${label}:${formatTimeAgo(Date.now() - timestamp)}`);
        }
      }
      appendModeBit(bits, account);
      const bot = account.bot as { username?: string | null } | undefined;
      const probeBot = (account.probe as { bot?: { username?: string | null } } | undefined)?.bot;
      const botUsername = normalizeOptionalString(bot?.username ?? probeBot?.username);
      if (botUsername) {
        bits.push(`bot:${botUsername.startsWith("@") ? botUsername : `@${botUsername}`}`);
      }
      if (typeof account.dmPolicy === "string" && account.dmPolicy.length > 0) {
        bits.push(`dm:${account.dmPolicy}`);
      }
      if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
        const allowFrom = account.allowFrom
          .slice(0, 2)
          .map((entry) => formatPhoneNumberForCli(String(entry)));
        bits.push(`allow:${allowFrom.join(",")}`);
      }
      appendTokenSourceBits(bits, account);
      const application = account.application as
        | { intents?: { messageContent?: string } }
        | undefined;
      const messageContent = application?.intents?.messageContent;
      if (
        typeof messageContent === "string" &&
        messageContent.length > 0 &&
        messageContent !== "enabled"
      ) {
        bits.push(`intents:content=${messageContent}`);
      }
      if (account.allowUnmentionedGroups === true) {
        bits.push("groups:unmentioned");
      }
      if (typeof account.healthState === "string" && account.healthState) {
        bits.push(`health:${account.healthState}`);
      }
      appendBaseUrlBit(bits, account);
      const probe = account.probe as { ok?: boolean } | undefined;
      if (probe && typeof probe.ok === "boolean") {
        bits.push(probe.ok ? "works" : "check failed");
      }
      const audit = account.audit as { ok?: boolean } | undefined;
      if (audit && typeof audit.ok === "boolean") {
        bits.push(audit.ok ? "audit ok" : "audit failed");
      }
      const rawChannelLabel = channelLabels[provider];
      return buildChannelAccountLine(provider, account, bits, {
        channelLabel: typeof rawChannelLabel === "string" ? rawChannelLabel : provider,
      });
    });

  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  const accountLinesStart = lines.length;
  for (const channelId of Object.keys(accountsByChannel ?? {}).toSorted()) {
    const accounts = accountsByChannel?.[channelId];
    if (Array.isArray(accounts) && accounts.length > 0) {
      lines.push(...accountLines(channelId, accounts));
    }
  }
  if (lines.length === accountLinesStart) {
    lines.push(theme.muted(NO_CONFIGURED_CHAT_CHANNELS_LINE));
  }

  lines.push("");
  const issues = collectChannelStatusIssues(payload);
  if (issues.length > 0) {
    lines.push(theme.warn("Warnings:"));
    for (const issue of issues) {
      lines.push(
        `- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`,
      );
    }
    lines.push(`- Run: ${formatCliCommand("openclaw doctor")}`);
    lines.push("");
  }
  lines.push(
    `Tip: ${formatDocsLink("/cli/status", "status --deep")} adds gateway health checks to status output (requires a reachable gateway).`,
  );
  return lines;
}

export async function renderChannelsStatusFallback(params: {
  opts: ChannelsStatusOptions;
  runtime: RuntimeEnv;
  safeError: string;
  gatewayAuthUnavailable: boolean;
  expectedErrorOutput?: string;
}): Promise<void> {
  const { opts, runtime, safeError, gatewayAuthUnavailable, expectedErrorOutput } = params;
  const fallbackReason = gatewayAuthUnavailable
    ? "Gateway auth unavailable; showing config-only status."
    : "Gateway not reachable; showing config-only status.";
  if (!opts.json) {
    runtime.error(
      expectedErrorOutput ??
        `${gatewayAuthUnavailable ? "Gateway auth unavailable" : "Gateway not reachable"}: ${safeError}`,
    );
  }
  const cfg = await requireValidConfig(runtime, { observe: false });
  if (!cfg) {
    return;
  }
  const { resolvedConfig } = await resolveCommandConfigWithSecrets({
    config: cfg,
    commandName: "channels status",
    targetIds: getConfiguredChannelsCommandSecretTargetIds(cfg),
    mode: "read_only_status",
    runtime,
  });
  const snapshot = await readConfigFileSnapshot({ observe: false });
  const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
  const requestedChannel = opts.channel
    ? (normalizeChannelId(opts.channel) ?? normalizeOptionalLowercaseString(opts.channel))
    : null;
  if (opts.json) {
    writeRuntimeJson(runtime, {
      gatewayReachable: false,
      error: safeError,
      gatewayAuthUnavailable,
      configOnly: true,
      config: { path: snapshot.path, mode },
      configuredChannels: listConfiguredAnnounceChannelIdsForConfig({
        config: resolvedConfig,
        activationSourceConfig: cfg,
        env: process.env,
      }).filter((channelId) => !requestedChannel || channelId === requestedChannel),
    });
    return;
  }
  runtime.log(
    (
      await formatConfigChannelsStatusLines(
        resolvedConfig,
        { path: snapshot.path, mode },
        { sourceConfig: cfg, channel: opts.channel, fallbackReason },
      )
    ).join("\n"),
  );
}
