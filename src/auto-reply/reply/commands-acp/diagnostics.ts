import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { formatAcpRuntimeErrorText, toAcpRuntimeError } from "../../../acp/runtime/errors.js";
import { getAcpRuntimeBackend, requireAcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntryAsync,
} from "../../../acp/runtime/session-meta.js";
import { listSessionBindingsBySessionsAsync } from "../../../infra/outbound/session-binding-service.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { resolveAcpInstallCommandHint } from "./install-hints.js";
import {
  ACP_DOCTOR_USAGE,
  ACP_INSTALL_USAGE,
  ACP_SESSIONS_USAGE,
  formatAcpCapabilitiesText,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

export async function handleAcpDoctorAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (restTokens.length > 0) {
    return commandReply(`⚠️ ${ACP_DOCTOR_USAGE}`);
  }

  const backendId = normalizeOptionalString(params.cfg.acp?.backend) ?? "acpx";
  const installHint = resolveAcpInstallCommandHint(params.cfg);
  const registeredBackend = getAcpRuntimeBackend(backendId);
  const managerSnapshot = getAcpSessionManager().getObservabilitySnapshot();
  const lines = [
    "ACP doctor:",
    "-----",
    `configuredBackend: ${backendId}`,
    `activeRuntimeSessions: ${managerSnapshot.runtimeCache.activeSessions}`,
    `runtimeIdleTtlMs: ${managerSnapshot.runtimeCache.idleTtlMs}`,
    `evictedIdleRuntimes: ${managerSnapshot.runtimeCache.evictedTotal}`,
    `activeTurns: ${managerSnapshot.turns.active}`,
    `queueDepth: ${managerSnapshot.turns.queueDepth}`,
    `turnLatencyMs: avg=${managerSnapshot.turns.averageLatencyMs}, max=${managerSnapshot.turns.maxLatencyMs}`,
    `turnCounts: completed=${managerSnapshot.turns.completed}, failed=${managerSnapshot.turns.failed}`,
  ];
  const errorStatsText =
    Object.entries(managerSnapshot.errorsByCode)
      .map(([code, count]) => `${code}=${count}`)
      .join(", ") || "(none)";
  lines.push(`errorCodes: ${errorStatsText}`);
  lines.push(`registeredBackend: ${registeredBackend ? registeredBackend.id : "(none)"}`);
  const allow = params.cfg.plugins?.allow;
  const normalizedBackendId = normalizeLowercaseStringOrEmpty(backendId);
  const backendBlockedByAllowlist =
    Array.isArray(allow) &&
    allow.length > 0 &&
    Boolean(normalizedBackendId) &&
    !allow.some((pluginId) => normalizeLowercaseStringOrEmpty(pluginId) === normalizedBackendId);
  if (backendBlockedByAllowlist) {
    lines.push(`pluginActivation: blocked (${backendId} is missing from plugins.allow)`);
  }

  if (registeredBackend?.runtime.doctor) {
    try {
      const report = await registeredBackend.runtime.doctor();
      lines.push(`runtimeDoctor: ${report.ok ? "ok" : "error"} (${report.message})`);
      if (report.code) {
        lines.push(`runtimeDoctorCode: ${report.code}`);
      }
      if (report.installCommand) {
        lines.push(`runtimeDoctorInstall: ${report.installCommand}`);
      }
      for (const detail of report.details ?? []) {
        lines.push(`runtimeDoctorDetail: ${detail}`);
      }
    } catch (error) {
      lines.push(
        `runtimeDoctor: error (${
          toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "Runtime doctor failed.",
          }).message
        })`,
      );
    }
  }

  try {
    const backend = requireAcpRuntimeBackend(backendId);
    const capabilities = backend.runtime.getCapabilities
      ? await backend.runtime.getCapabilities({})
      : { controls: [] as string[], configOptionKeys: [] as string[] };
    lines.push("healthy: yes");
    lines.push(`capabilities: ${formatAcpCapabilitiesText(capabilities.controls ?? [])}`);
    if ((capabilities.configOptionKeys?.length ?? 0) > 0) {
      lines.push(`configKeys: ${capabilities.configOptionKeys?.join(", ")}`);
    }
  } catch (error) {
    const acpError = toAcpRuntimeError({
      error,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP backend doctor failed.",
    });
    lines.push("healthy: no");
    lines.push(formatAcpRuntimeErrorText(acpError));
    if (backendBlockedByAllowlist) {
      lines.push(`next: add "${backendId}" to plugins.allow or unset plugins.allow.`);
    }
    lines.push(`next: ${installHint}`);
    lines.push(`next: openclaw config set plugins.entries.${backendId}.enabled true`);
    if (normalizedBackendId === "acpx") {
      lines.push("next: verify acpx is installed (`acpx --help`).");
    }
  }
  return commandReply(lines.join("\n"));
}

export function handleAcpInstallAction(
  params: HandleCommandsParams,
  restTokens: string[],
): CommandHandlerResult {
  if (restTokens.length > 0) {
    return commandReply(`⚠️ ${ACP_INSTALL_USAGE}`);
  }
  const backendId = normalizeOptionalString(params.cfg.acp?.backend) ?? "acpx";
  const installHint = resolveAcpInstallCommandHint(params.cfg);
  const lines = [
    "ACP install:",
    "-----",
    `configuredBackend: ${backendId}`,
    `run: ${installHint}`,
    `then: openclaw config set plugins.entries.${backendId}.enabled true`,
    "then: /acp doctor",
  ];
  return commandReply(lines.join("\n"));
}

export async function handleAcpSessionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (restTokens.length > 0) {
    return commandReply(ACP_SESSIONS_USAGE);
  }

  const target = await resolveAcpTargetSessionKey({ commandParams: params });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }
  const currentSessionKey = target.sessionKey;

  const bindingContext = resolveAcpCommandBindingContext(params);
  const normalizedChannel = bindingContext.channel;
  const normalizedAccountId = bindingContext.accountId || undefined;
  const currentEntry = params.command.senderIsOwner
    ? null
    : await readAcpSessionEntryAsync({
        cfg: params.cfg,
        sessionKey: currentSessionKey,
        agentId: target.agentId,
        assertCurrent: params.command.assertOwnerCurrent,
      });
  params.command.assertOwnerCurrent?.();
  const visibleEntries = params.command.senderIsOwner
    ? await listAcpSessionEntries({ cfg: params.cfg })
    : currentEntry?.entry && currentEntry.acp
      ? [currentEntry]
      : [];
  params.command.assertOwnerCurrent?.();

  const selectedEntries = visibleEntries
    .toSorted((a, b) => (b.entry?.updatedAt ?? 0) - (a.entry?.updatedAt ?? 0))
    .slice(0, 20);
  const bindingsBySession = await listSessionBindingsBySessionsAsync(
    selectedEntries
      .filter(({ entry, acp }) => entry && acp)
      .map(({ storeSessionKey }) => storeSessionKey),
  );
  params.command.assertOwnerCurrent?.();
  const rows = selectedEntries
    .map(({ storeSessionKey, agentId, entry, acp }) => {
      if (!entry || !acp) {
        return "";
      }
      const bindingThreadId = (bindingsBySession.get(storeSessionKey) ?? []).find(
        (binding) =>
          (!normalizedChannel || binding.conversation.channel === normalizedChannel) &&
          (!normalizedAccountId || binding.conversation.accountId === normalizedAccountId),
      )?.conversation.conversationId;
      const marker =
        currentSessionKey === storeSessionKey && target.agentId === agentId ? "*" : " ";
      const label = normalizeOptionalString(entry.label) || acp.agent;
      const threadText = bindingThreadId ? `, thread:${bindingThreadId}` : "";
      return `${marker} ${label} (${acp.mode}, ${acp.state}, backend:${acp.backend}${agentId ? `, owner:${agentId}` : ""}${threadText}) -> ${storeSessionKey}`;
    })
    .filter(Boolean);

  return commandReply(["ACP sessions:", "-----", ...(rows.length ? rows : ["(none)"])].join("\n"));
}
