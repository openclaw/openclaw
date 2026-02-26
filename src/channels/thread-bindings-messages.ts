import { prefixSystemMessage } from "../infra/system-message.js";

const DEFAULT_THREAD_BINDING_FAREWELL_TEXT =
  "Session ended. Messages here will no longer be routed.";

function normalizeThreadBindingMessageTtlMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  const ttlMs = Math.floor(raw);
  if (ttlMs < 0) {
    return 0;
  }
  return ttlMs;
}

export function formatThreadBindingTtlLabel(ttlMs: number): string {
  if (ttlMs <= 0) {
    return "disabled";
  }
  if (ttlMs < 60_000) {
    return "<1m";
  }
  const totalMinutes = Math.floor(ttlMs / 60_000);
  if (totalMinutes % 60 === 0) {
    return `${Math.floor(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

export function resolveThreadBindingThreadName(params: {
  agentId?: string;
  label?: string;
}): string {
  const label = params.label?.trim();
  const base = label || params.agentId?.trim() || "agent";
  const raw = `🤖 ${base}`.replace(/\s+/g, " ").trim();
  return raw.slice(0, 100);
}

export function resolveThreadBindingIntroText(params: {
  agentId?: string;
  label?: string;
  sessionTtlMs?: number;
  sessionCwd?: string;
  sessionDetails?: string[];
}): string {
  const label = params.label?.trim();
  const base = label || params.agentId?.trim() || "agent";
  const normalized = base.replace(/\s+/g, " ").trim().slice(0, 100) || "agent";
  const ttlMs = normalizeThreadBindingMessageTtlMs(params.sessionTtlMs);
  const cwd = params.sessionCwd?.trim();
  const details = (params.sessionDetails ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (cwd) {
    details.unshift(`cwd: ${cwd}`);
  }
  const intro =
    ttlMs > 0
      ? `${normalized} session active (auto-unfocus in ${formatThreadBindingTtlLabel(ttlMs)}). Messages here go directly to this session.`
      : `${normalized} session active. Messages here go directly to this session.`;
  if (details.length === 0) {
    return prefixSystemMessage(intro);
  }
  return prefixSystemMessage(`${intro}\n${details.join("\n")}`);
}

export function resolveThreadBindingFarewellText(params: {
  reason?: string;
  farewellText?: string;
  sessionTtlMs: number;
}): string {
  const custom = params.farewellText?.trim();
  if (custom) {
    return prefixSystemMessage(custom);
  }
  if (params.reason === "ttl-expired") {
    return prefixSystemMessage(
      `Session ended automatically after ${formatThreadBindingTtlLabel(params.sessionTtlMs)}. Messages here will no longer be routed.`,
    );
  }
  return prefixSystemMessage(DEFAULT_THREAD_BINDING_FAREWELL_TEXT);
}
