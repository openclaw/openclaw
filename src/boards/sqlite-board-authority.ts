import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  captureExternalSessionCommitGuard,
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BoardSourceRefusal } from "./sqlite-board-store.worker.js";

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
      const refused = isRecord(request.facts) && request.facts.boardSourceRefused;
      if (refused) {
        // SAFETY: The paired Board worker publishes this private refusal payload.
        const refusal = refused as BoardSourceRefusal;
        source.checks[refusal.index]?.refuse(refusal.facts);
        throw new Error("Board source refusal omitted its authority assertion");
      }
      return request;
    },
  };
}
