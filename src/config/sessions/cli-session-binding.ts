// CLI session binding lookup shared by session lifecycle and agent runtime code.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, CliSessionReseedReceipt, SessionEntry } from "./types.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
type CliSessionBindingEntry = Pick<
  SessionEntry,
  "claudeCliSessionId" | "cliSessionBindings" | "cliSessionIds"
>;

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

/** Read the stored CLI session binding for a provider, including legacy Claude state. */
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
  // A binding record with no session id is the auth-boundary tombstone
  // `clearCliSession` leaves behind. It must still reach reuse resolution, which
  // is the only thing that can tell "never bound" apart from "bound under a
  // different auth identity". Checked after the legacy maps so a real id always
  // wins.
  //
  // Because it resumes nothing, any caller that reads the result as "a native
  // transcript exists" MUST gate on `sessionId` — a truthiness test admits the
  // tombstone. This is not something the return type enforces, and it has been
  // gotten wrong repeatedly; the gates live in `hasProviderOwnedSession`
  // (`entry-freshness.ts`), its reply-lane twin (`auto-reply/reply/session.ts`),
  // `resolveManualCompactionCliTarget` (`agents/session-runtime-compat.ts`),
  // `resolveEligibleCliSessionBinding` (`gateway/cli-session-history.ts`), and
  // `gateway/agent-turn/agent-handler-helpers.ts`. Reuse resolution and
  // auth-provenance readers are the deliberate exceptions: they want the
  // tombstone precisely because it has no id — `resolveManualCompactionCliTarget`
  // still returns one as `cliSessionBinding` while reporting `cliSessionId`
  // undefined, which is the shape those readers expect. Any new caller has to
  // pick a side explicitly.
  const clearedAuthProfileId = normalizeOptionalString(fromBindings?.authProfileId);
  const clearedAuthEpoch = normalizeOptionalString(fromBindings?.authEpoch);
  // The epoch version alone still identifies a tombstone: an install with
  // neither an auth profile nor a resolvable credential epoch has an empty
  // identity, and a versioned record of that emptiness is what lets the next
  // turn tell "the identity is still empty" (reuse resolution returns no
  // invalidation, so raw reseed stays eligible) from "an identity appeared"
  // (reuse resolution reports the crossing and reseed is refused). Older
  // readers, which required a profile or epoch here, simply fall through to
  // `undefined` and behave exactly as they did before the field existed.
  const clearedAuthEpochVersion =
    typeof fromBindings?.authEpochVersion === "number" &&
    Number.isFinite(fromBindings.authEpochVersion)
      ? fromBindings.authEpochVersion
      : undefined;
  // An unknown-provenance tombstone carries no identity fields at all, so it has
  // to be recognized by its own marker: compared as an identity it would read as
  // "empty identity" and could match a current turn that also resolves none,
  // which is exactly the match it must never make.
  const clearedAuthProvenance =
    fromBindings?.clearedAuthProvenance === "unknown" ? ("unknown" as const) : undefined;
  if (
    clearedAuthProfileId ||
    clearedAuthEpoch ||
    clearedAuthEpochVersion !== undefined ||
    clearedAuthProvenance
  ) {
    return {
      ...(clearedAuthProfileId ? { authProfileId: clearedAuthProfileId } : {}),
      ...(clearedAuthEpoch ? { authEpoch: clearedAuthEpoch } : {}),
      ...(clearedAuthEpochVersion !== undefined
        ? { authEpochVersion: clearedAuthEpochVersion }
        : {}),
      ...(clearedAuthProvenance ? { clearedAuthProvenance } : {}),
    };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    // Keep accepting the shipped Claude-only field until stored sessions migrate.
    const legacy = normalizeOptionalString(entry.claudeCliSessionId);
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

/** Read just the reusable CLI session ID for a provider. */
export function getCliSessionId(
  entry: CliSessionBindingEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

export function clearAllCliSessions(
  entry: Partial<Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId">>,
): void {
  entry.cliSessionBindings = undefined;
  entry.cliSessionIds = undefined;
  entry.claudeCliSessionId = undefined;
}
