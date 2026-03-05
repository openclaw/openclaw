import type { ConfigWriteTransactionResult, ConfigWriteTransactionStage } from "./transaction.js";
import type { ConfigFileSnapshot } from "./types.js";

export type ConfigWriteFailureDetails = {
  transactionId?: string;
  stage: ConfigWriteTransactionStage | null;
  rolledBack: boolean;
  reason: string;
  issues?: ConfigFileSnapshot["issues"];
};

function isTransactionStage(value: string): value is ConfigWriteTransactionStage {
  return value === "prepare" || value === "commit" || value === "verify" || value === "rollback";
}

function resolveRecoveryStateHint(params: {
  stage: ConfigWriteTransactionStage | null;
  rolledBack: boolean;
}): string {
  if (params.rolledBack) {
    return "rolled back to the previous version";
  }
  if (params.stage === "prepare" || params.stage === "commit") {
    return "config file left unchanged";
  }
  if (params.stage === "rollback") {
    return "rollback did not complete";
  }
  return "config state not confirmed";
}

function extractReasonFromLegacyMessage(message: string): string {
  const prefix = "writeConfigFile transaction failed;";
  const prefixIndex = message.indexOf(prefix);
  if (prefixIndex < 0) {
    return message.trim() || "unknown error";
  }
  let tail = message.slice(prefixIndex + prefix.length).trim();
  tail = tail.replace(/^stage=(prepare|commit|verify|rollback);\s*/, "");
  tail = tail.replace(/^rollback=ok;\s*/, "");
  const firstSegment = tail.split(";")[0]?.trim();
  return firstSegment || "unknown error";
}

export class ConfigWriteTransactionError extends Error {
  readonly transactionId: string;
  readonly stage: ConfigWriteTransactionStage | null;
  readonly rolledBack: boolean;
  readonly reason: string;
  readonly issues?: ConfigFileSnapshot["issues"];

  constructor(result: ConfigWriteTransactionResult) {
    const reason = result.error ?? "unknown error";
    const stageLabel = result.stage ? ` stage=${result.stage};` : "";
    const rollbackLabel = result.rolledBack ? " rollback=ok;" : "";
    const recoveryHint = resolveRecoveryStateHint({
      stage: result.stage,
      rolledBack: result.rolledBack,
    });
    super(
      `writeConfigFile transaction failed;${stageLabel}${rollbackLabel} ${reason}; last config update failed (${recoveryHint}); please retry`,
    );
    this.name = "ConfigWriteTransactionError";
    this.transactionId = result.transactionId;
    this.stage = result.stage;
    this.rolledBack = result.rolledBack;
    this.reason = reason;
    this.issues = result.issues;
  }
}

export function describeConfigWriteFailure(error: unknown): ConfigWriteFailureDetails | null {
  if (error instanceof ConfigWriteTransactionError) {
    return {
      transactionId: error.transactionId,
      stage: error.stage,
      rolledBack: error.rolledBack,
      reason: error.reason,
      issues: error.issues,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("writeConfigFile transaction failed;")) {
    return null;
  }
  const stageMatch = message.match(/\bstage=(prepare|commit|verify|rollback);/);
  const stage = stageMatch && isTransactionStage(stageMatch[1]) ? stageMatch[1] : null;
  return {
    stage,
    rolledBack: /\brollback=ok;/.test(message),
    reason: extractReasonFromLegacyMessage(message),
  };
}

export function formatConfigWriteFailureForCli(error: unknown): string | null {
  const details = describeConfigWriteFailure(error);
  if (!details) {
    return null;
  }
  const stateText = details.rolledBack
    ? "Last config update failed and was rolled back to the previous version."
    : details.stage === "prepare" || details.stage === "commit"
      ? "Last config update failed before changing your config file."
      : details.stage === "rollback"
        ? "Last config update failed and rollback did not complete."
        : "Last config update failed.";
  const reasonText = details.reason ? ` Error: ${details.reason}.` : "";
  return `${stateText}${reasonText} Retry the command.`;
}

export function formatConfigWriteFailureForChannel(error: unknown): string | null {
  const details = describeConfigWriteFailure(error);
  if (!details) {
    return null;
  }
  const stateText = details.rolledBack
    ? "Changes were rolled back to the previous version."
    : details.stage === "prepare" || details.stage === "commit"
      ? "Config was not changed."
      : details.stage === "rollback"
        ? "Rollback did not complete; check your config before retrying."
        : "Config state could not be confirmed.";
  const reasonText = details.reason ? ` Reason: ${details.reason}.` : "";
  return `⚠️ Config update failed. ${stateText}${reasonText} Please retry.`;
}
