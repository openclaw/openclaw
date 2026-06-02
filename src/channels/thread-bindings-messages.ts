import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { prefixSystemMessage } from "../infra/system-message.js";

const DEFAULT_THREAD_BINDING_FAREWELL_TEXT =
  "Session ended. Messages here will no longer be routed.";

function normalizeThreadBindingDurationMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  const durationMs = Math.floor(raw);
  if (durationMs < 0) {
    return 0;
  }
  return durationMs;
}

/** Formats a thread-binding timeout duration for short user-facing lifecycle messages. */
export function formatThreadBindingDurationLabel(durationMs: number): string {
  if (durationMs <= 0) {
    return "disabled";
  }
  if (durationMs < 60_000) {
    return "<1m";
  }
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes % 60 === 0) {
    return `${Math.floor(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

/** Resolves the thread name used for a focused session binding. */
export function resolveThreadBindingThreadName(params: {
  /** Agent id used when no human label is available. */
  agentId?: string;
  /** Human label preferred for the thread title. */
  label?: string;
}): string {
  const label = normalizeOptionalString(params.label);
  const base = label || normalizeOptionalString(params.agentId) || "agent";
  const raw = `🤖 ${base}`.replace(/\s+/g, " ").trim();
  return raw.slice(0, 100);
}

/** Builds the system-prefixed intro message posted when a thread binding starts. */
export function resolveThreadBindingIntroText(params: {
  /** Agent id used when no human label is available. */
  agentId?: string;
  /** Human label preferred in the intro text. */
  label?: string;
  /** Idle timeout displayed when configured. */
  idleTimeoutMs?: number;
  /** Maximum binding age displayed when configured. */
  maxAgeMs?: number;
  /** Session cwd appended as a detail line. */
  sessionCwd?: string;
  /** Additional non-empty detail lines appended below the intro. */
  sessionDetails?: string[];
}): string {
  const label = normalizeOptionalString(params.label);
  const base = label || normalizeOptionalString(params.agentId) || "agent";
  const normalized = base.replace(/\s+/g, " ").trim().slice(0, 100) || "agent";
  const idleTimeoutMs = normalizeThreadBindingDurationMs(params.idleTimeoutMs);
  const maxAgeMs = normalizeThreadBindingDurationMs(params.maxAgeMs);
  const cwd = normalizeOptionalString(params.sessionCwd);
  const details = (params.sessionDetails ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (cwd) {
    // Keep cwd first so operators can scan the most actionable session detail immediately.
    details.unshift(`cwd: ${cwd}`);
  }

  const lifecycle: string[] = [];
  if (idleTimeoutMs > 0) {
    lifecycle.push(
      `idle auto-unfocus after ${formatThreadBindingDurationLabel(idleTimeoutMs)} inactivity`,
    );
  }
  if (maxAgeMs > 0) {
    lifecycle.push(`max age ${formatThreadBindingDurationLabel(maxAgeMs)}`);
  }

  const intro =
    lifecycle.length > 0
      ? `${normalized} session active (${lifecycle.join("; ")}). Messages here go directly to this session.`
      : `${normalized} session active. Messages here go directly to this session.`;

  if (details.length === 0) {
    return prefixSystemMessage(intro);
  }
  return prefixSystemMessage(`${intro}\n${details.join("\n")}`);
}

/** Builds the system-prefixed farewell message posted when a thread binding ends. */
export function resolveThreadBindingFarewellText(params: {
  /** End reason used to pick timeout-specific copy. */
  reason?: string;
  /** Caller-provided farewell text that overrides generated timeout/default copy. */
  farewellText?: string;
  /** Idle timeout used when reason is idle-expired. */
  idleTimeoutMs: number;
  /** Maximum binding age used when reason is max-age-expired. */
  maxAgeMs: number;
}): string {
  const custom = normalizeOptionalString(params.farewellText);
  if (custom) {
    return prefixSystemMessage(custom);
  }

  if (params.reason === "idle-expired") {
    const label = formatThreadBindingDurationLabel(
      normalizeThreadBindingDurationMs(params.idleTimeoutMs),
    );
    return prefixSystemMessage(
      `Session ended automatically after ${label} of inactivity. Messages here will no longer be routed.`,
    );
  }

  if (params.reason === "max-age-expired") {
    const label = formatThreadBindingDurationLabel(
      normalizeThreadBindingDurationMs(params.maxAgeMs),
    );
    return prefixSystemMessage(
      `Session ended automatically at max age of ${label}. Messages here will no longer be routed.`,
    );
  }

  return prefixSystemMessage(DEFAULT_THREAD_BINDING_FAREWELL_TEXT);
}
