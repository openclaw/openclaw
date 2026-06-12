/** Audit metadata for deterministic command jobs and legacy agentTurn scripts. */
import type { CronPayload } from "./types.js";

export type CronPayloadAuditExecutionKind =
  | "system-event"
  | "agent-turn"
  | "deterministic-command";

export type CronPayloadAuditWarningCode = "hidden-agent-turn-script";

export type CronPayloadAuditWarning = {
  code: CronPayloadAuditWarningCode;
  severity: "warn";
  message: string;
  recommendation?: string;
};

export type CronPayloadAuditMetadata = {
  executionKind: CronPayloadAuditExecutionKind;
  deterministic: boolean;
  warnings: CronPayloadAuditWarning[];
};

const SCRIPT_BLOCK_RE = /```(?:bash|sh|zsh|shell|js|ts|node|python|py)?\s+[\s\S]*?```/iu;
const SHELL_COMMAND_RE =
  /(?:^|\n)\s*(?:\$\s*)?(?:bash|sh|zsh|node|python3?|pnpm|npm|bun|openclaw|curl|wget|sqlite3|psql|rsync|scp|ssh)\s+[\w./:-]/iu;
const EXACT_SCRIPT_LANGUAGE_RE =
  /\b(?:run|execute|call|invoke)\s+(?:this\s+)?(?:exact|deterministic|scheduled)?\s*(?:script|command|job)\b/iu;

function looksLikeHiddenScript(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }
  if (SCRIPT_BLOCK_RE.test(normalized) && SHELL_COMMAND_RE.test(normalized)) {
    return true;
  }
  return EXACT_SCRIPT_LANGUAGE_RE.test(normalized) && SHELL_COMMAND_RE.test(normalized);
}

function hiddenAgentTurnScriptWarning(): CronPayloadAuditWarning {
  return {
    code: "hidden-agent-turn-script",
    severity: "warn",
    message:
      'This scheduled agentTurn appears to hide a deterministic script. Prefer payload.kind="command" with an explicit argv vector for scheduled command jobs.',
    recommendation:
      'Convert the job payload to { "kind": "command", "argv": [...] } so scheduler JSON exposes the deterministic command directly.',
  };
}

export function resolveCronPayloadAudit(payload: CronPayload): CronPayloadAuditMetadata {
  if (payload.kind === "command") {
    return {
      executionKind: "deterministic-command",
      deterministic: true,
      warnings: [],
    };
  }

  if (payload.kind === "agentTurn") {
    return {
      executionKind: "agent-turn",
      deterministic: false,
      warnings: looksLikeHiddenScript(payload.message) ? [hiddenAgentTurnScriptWarning()] : [],
    };
  }

  return {
    executionKind: "system-event",
    deterministic: false,
    warnings: [],
  };
}
