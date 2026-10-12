import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  acceptSessionSourceValidation,
  captureExternalSessionCommitGuard,
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourceValidation,
} from "../config/sessions/session-source-authority.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("boards/store");

export function reportBoardCleanupFailure(error: unknown) {
  try {
    log.warn(`Board publication completed before cleanup failed: ${formatErrorMessage(error)}`);
  } catch {
    // The resource owner retains cleanup; diagnostics cannot reverse a committed result.
  }
}

export async function prepareBoardSourceAuthority(
  assertion: SessionSourceAssertion | undefined,
  identity: DatabasePathIdentity,
) {
  const source = await prepareSessionSourceAuthority(captureExternalSessionCommitGuard(assertion));
  return {
    ...source,
    nativeSource:
      source.nativeSource ||
      source.checks.some(
        ({ predicate }) =>
          typeof predicate.source.databaseIdentity !== "string" ||
          `file:${predicate.source.databaseIdentity}` !== identity.key,
      ),
    assertAdmission(this: void, request: SqliteWorkerAdmissionRequest) {
      const validation = isRecord(request.facts) && request.facts.boardSourceValidation;
      if (validation) {
        // SAFETY: The paired Board worker supplies transaction-held source validation.
        acceptSessionSourceValidation(source, validation as SessionSourceValidation);
      }
      return request;
    },
  };
}
