import { warnSessionTranscriptPreparationDeprecation } from "../../plugins/compat/session-transcript-preparation-deprecation.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptTurnMessageAppend,
  TranscriptMessageAppendOptions,
} from "./session-accessor.types.js";
import { captureExternalSessionCommitGuard } from "./session-source-authority.js";

export function assertLegacyTranscriptPreparation<TMessage>(
  scope: SessionTranscriptWriteScope,
  options?: TranscriptMessageAppendOptions<TMessage>,
): void {
  if (
    options &&
    !options.prepareMessageAfterIdempotencyCheck &&
    !options.beforeFreshMessageCommit
  ) {
    return;
  }
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    (scope.storePath && resolveExplicitIncognitoAgentSqliteTarget(scope.storePath, scope))
  ) {
    throw new Error(
      "Opaque transcript callbacks are unavailable for incognito sessions. Use withSessionTranscriptWrite and preparation.prepareMessage / preparation.source instead.",
    );
  }
  warnSessionTranscriptPreparationDeprecation();
}

/** Turn workers serialize prepared values and source predicates, never host preparation callbacks. */
export function normalizeTranscriptMessagePreparation(
  append: SessionTranscriptTurnMessageAppend,
): SessionTranscriptTurnMessageAppend {
  const { preparation, ...message } = append;
  if (!preparation) {
    return append;
  }
  if (
    append.prepareMessageAfterIdempotencyCheck ||
    append.beforeFreshMessageCommit ||
    append.workerPreparation
  ) {
    throw new Error("Choose preparation or the legacy transcript callback form, not both.");
  }
  return {
    ...message,
    workerPreparation: {
      prepareMessageAfterIdempotencyCheckAsync: preparation.prepareMessage,
      beforeFreshMessageCommit: captureExternalSessionCommitGuard(preparation.source),
    },
  };
}
