/**
 * Preflight guardrails before applying channel token/config (fixes #37302).
 * Ensures the operator explicitly confirms the target (channel + accountId)
 * before write, reducing risk of applying token to the wrong bot/context.
 */

import type { WizardPrompter } from "../../wizard/prompts.js";

export type PreflightChannelConfigWriteParams = {
  channel: string;
  accountId: string;
  /** When set, prompt for confirmation (interactive). */
  prompter?: Pick<WizardPrompter, "confirm">;
  /** When true (e.g. CLI --confirm-target), skip interactive prompt and allow write. */
  confirmTarget?: boolean;
};

export type PreflightChannelConfigWriteResult = { ok: true } | { ok: false; reason: string };

/**
 * Runs preflight before writing channel account config. When interactive (prompter
 * provided), prompts to confirm target. When non-interactive, requires confirmTarget
 * to be set or the write is blocked.
 */
export async function preflightChannelConfigWrite(
  params: PreflightChannelConfigWriteParams,
): Promise<PreflightChannelConfigWriteResult> {
  const { channel, accountId, prompter, confirmTarget } = params;
  const targetLabel = `${channel} account "${accountId}"`;

  if (prompter) {
    const confirmed = await prompter.confirm({
      message: `Apply config to ${targetLabel}?`,
      initialValue: true,
    });
    if (!confirmed) {
      return { ok: false, reason: "Target confirmation cancelled." };
    }
    return { ok: true };
  }

  if (confirmTarget) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Preflight: pass --confirm-target to apply token/config to ${targetLabel}, or run without channel flags for interactive confirmation.`,
  };
}

export type PreflightChannelConfigWriteBatchParams = {
  targets: Array<{ channel: string; accountId: string }>;
  prompter: Pick<WizardPrompter, "confirm">;
};

/**
 * Preflight for a batch write (e.g. wizard writing multiple channel accounts).
 * Single confirmation for the whole set.
 */
export async function preflightChannelConfigWriteBatch(
  params: PreflightChannelConfigWriteBatchParams,
): Promise<PreflightChannelConfigWriteResult> {
  const { targets, prompter } = params;
  if (targets.length === 0) {
    return { ok: true };
  }
  const label =
    targets.length === 1
      ? `${targets[0].channel} account "${targets[0].accountId}"`
      : `${targets.length} channel accounts (${targets.map((t) => `${t.channel}/${t.accountId}`).join(", ")})`;
  const confirmed = await prompter.confirm({
    message: `Apply config to ${label}?`,
    initialValue: true,
  });
  if (!confirmed) {
    return { ok: false, reason: "Target confirmation cancelled." };
  }
  return { ok: true };
}
