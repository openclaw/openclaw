// CLI session binding lookup shared by session lifecycle and agent runtime code.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { cliBackendSupportsSessionFork } from "../../agents/cli-backends.js";
import type { CliSessionBinding, CliSessionReseedReceipt, SessionEntry } from "./types.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
type CliSessionBindingEntry = Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds">;

export function normalizeCliSessionReseedReceipt(
  value: CliSessionReseedReceipt | undefined,
): CliSessionReseedReceipt | undefined {
  const promptHash = normalizeOptionalString(value?.promptHash);
  const localSessionId = normalizeOptionalString(value?.localSessionId);
  const userTurnDisposition = value?.userTurnDisposition;
  if (
    value?.version !== 1 ||
    !promptHash ||
    !SHA256_HEX_PATTERN.test(promptHash) ||
    !localSessionId ||
    (userTurnDisposition !== "persisted" && userTurnDisposition !== "omitted")
  ) {
    return undefined;
  }
  return {
    version: 1,
    promptHash,
    localSessionId,
    userTurnDisposition,
  };
}

/**
 * Re-own omitted reseed receipts when a reset intentionally preserves the
 * native CLI conversation. Persisted turns keep their old owner and fail open
 * because their canonical user row belongs to the archived local transcript.
 */
export function rebindCliSessionReseedReceiptsForReset(
  bindings: Record<string, CliSessionBinding> | undefined,
  localSessionId: string,
): Record<string, CliSessionBinding> | undefined {
  const normalizedLocalSessionId = normalizeOptionalString(localSessionId);
  if (!bindings || !normalizedLocalSessionId) {
    return bindings;
  }

  let rebound: Record<string, CliSessionBinding> | undefined;
  for (const [provider, binding] of Object.entries(bindings)) {
    const receipt = normalizeCliSessionReseedReceipt(binding.reseedReceipt);
    if (!receipt || receipt.userTurnDisposition !== "omitted") {
      continue;
    }
    rebound ??= { ...bindings };
    rebound[provider] = {
      ...binding,
      reseedReceipt: {
        ...receipt,
        localSessionId: normalizedLocalSessionId,
      },
    };
  }
  return rebound ?? bindings;
}

/** Read the stored provider-keyed CLI session binding. */
export function getCliSessionBinding(
  entry: CliSessionBindingEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      resumeCheckpointId: normalizeOptionalString(fromBindings?.resumeCheckpointId),
      ...(fromBindings?.forceReuse === true ? { forceReuse: true } : {}),
      ...(fromBindings?.forkNextResume === true ? { forkNextResume: true } : {}),
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      authEpochVersion: fromBindings?.authEpochVersion,
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      messageToolPolicyHash: normalizeOptionalString(fromBindings?.messageToolPolicyHash),
      promptToolNamesHash: normalizeOptionalString(fromBindings?.promptToolNamesHash),
      cwdHash: normalizeOptionalString(fromBindings?.cwdHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
      mcpResumeHash: normalizeOptionalString(fromBindings?.mcpResumeHash),
      reseedReceipt: normalizeCliSessionReseedReceipt(fromBindings?.reseedReceipt),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  return undefined;
}

/**
 * Carry a parent's native CLI sessions into a forked child. The child resumes
 * each backend session once with its fork flag, so the native context branches
 * instead of starting empty. The copied fingerprints are still validated on the
 * child's first turn, so an account or environment change starts fresh instead
 * of resuming under the wrong credential. Only bindings with a recorded
 * checkpoint are copied: the runner pins the fork resume to it, so the branch
 * point stays the parent's last committed turn even if the parent keeps going.
 * Backends without a fork flag are skipped: resuming them would share the
 * parent's native thread, so the child starts a fresh one as before. The
 * parent's reseed receipt names the parent's local session, so it is dropped.
 */
export function forkCliSessionBindings(
  parent: CliSessionBindingEntry | undefined,
  supportsFork: (provider: string) => boolean = cliBackendSupportsSessionFork,
): Record<string, CliSessionBinding> | undefined {
  const providers = new Set([
    ...Object.keys(parent?.cliSessionBindings ?? {}),
    ...Object.keys(parent?.cliSessionIds ?? {}),
  ]);
  const forked: Record<string, CliSessionBinding> = {};
  for (const provider of providers) {
    const binding = getCliSessionBinding(parent, provider);
    if (binding?.resumeCheckpointId && supportsFork(provider)) {
      const { reseedReceipt: _reseedReceipt, forceReuse: _forceReuse, ...inherited } = binding;
      forked[normalizeProviderId(provider)] = { ...inherited, forkNextResume: true };
    }
  }
  return Object.keys(forked).length > 0 ? forked : undefined;
}

export function clearAllCliSessions(
  entry: Partial<Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId">>,
): void {
  entry.cliSessionBindings = undefined;
  entry.cliSessionIds = undefined;
  entry.claudeCliSessionId = undefined;
}
