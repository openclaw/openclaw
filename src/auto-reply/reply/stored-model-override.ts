// Resolves stored model pins and their fallback probes against the current turn.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveStoredModelOverrideAsync } from "../../sessions/stored-model-overrides.js";

/** Keep stored-pin selection and primary probing under the same turn-local precedence. */
export async function resolveReplyStoredModelSelection(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  parentSessionKey?: string;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider: string;
  primaryModel: string;
  sessionModelSelectionLocked: boolean;
  hasResolvedTurnModelOverride: boolean;
}) {
  const { sessionEntry, sessionModelSelectionLocked, hasResolvedTurnModelOverride } = params;
  const hasSessionModelOverride = Boolean(
    normalizeOptionalString(sessionEntry.modelOverride) ||
    normalizeOptionalString(sessionEntry.providerOverride),
  );
  const storedOverride = await resolveStoredModelOverrideAsync(params);
  const staleLegacyAutoFallbackWithoutOrigin =
    !sessionModelSelectionLocked &&
    storedOverride?.source === "session" &&
    hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
  const modelOverride =
    storedOverride?.model && !hasResolvedTurnModelOverride && !staleLegacyAutoFallbackWithoutOrigin
      ? {
          provider: storedOverride.provider ?? params.defaultProvider,
          model: storedOverride.model,
        }
      : undefined;
  const autoFallbackPrimaryProbe =
    !sessionModelSelectionLocked && !hasResolvedTurnModelOverride
      ? resolveAutoFallbackPrimaryProbe({
          entry: sessionEntry,
          sessionKey: params.sessionKey,
          primaryProvider: params.primaryProvider,
          primaryModel: params.primaryModel,
        })
      : undefined;
  return {
    modelOverride,
    autoFallbackPrimaryProbe,
    hasEffectiveStoredModelOverride:
      Boolean(storedOverride || hasSessionModelOverride) && !staleLegacyAutoFallbackWithoutOrigin,
  };
}
