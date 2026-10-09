import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
  SessionEntriesCurrentCheck,
} from "./session-entry-current.types.js";

function decodeSessionEntryCurrentFacts(
  value: unknown,
  capability: boolean,
): SessionEntryCurrentFacts | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Session currency facts have an invalid entry identity");
  }
  if (capability) {
    return {
      sessionId: value.sessionId,
      spawnedBy: value.spawnedBy,
      spawnDepth: value.spawnDepth,
      completionOwnerSessionKey: value.completionOwnerSessionKey,
      subagentRole: value.subagentRole,
      subagentControlScope: value.subagentControlScope,
      inheritedToolPolicyVersion: value.inheritedToolPolicyVersion,
      inheritedToolPolicySource: value.inheritedToolPolicySource,
      inheritedToolAllow: value.inheritedToolAllow,
      inheritedToolDeny: value.inheritedToolDeny,
    };
  }
  const recovery = value.subagentRecovery;
  if (recovery !== undefined && !isRecord(recovery)) {
    throw new Error("Session currency facts have an invalid recovery projection");
  }
  return {
    sessionId: value.sessionId,
    previousSessionId: value.previousSessionId,
    ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt }),
    ...(value.repositoryWorkspaceId === undefined
      ? {}
      : { repositoryWorkspaceId: value.repositoryWorkspaceId }),
    lifecycleRevision: value.lifecycleRevision,
    lifecycleRunId: value.lifecycleRunId,
    activeWriterRunId: value.activeWriterRunId,
    ...(recovery
      ? {
          subagentRecovery: {
            lastRunId: recovery.lastRunId,
            sessionLifecycleRunId: recovery.sessionLifecycleRunId,
          },
        }
      : {}),
  };
}

/** Evaluate the caller's policy against the native request's facts before its ordinary grant. */
export function assertSessionEntryCurrentAdmission(
  request: SqliteWorkerAdmissionRequest,
  check: SessionEntryCurrentCheck | undefined,
): SqliteWorkerAdmissionRequest {
  if (!check) {
    if (isRecord(request.facts) && request.facts.kind === "session-entry-current") {
      throw new Error("Session currency facts have no captured caller");
    }
    return request;
  }
  const facts = request.facts;
  if (
    !isRecord(facts) ||
    facts.kind !== "session-entry-current" ||
    !isRecord(facts.source) ||
    facts.source.agentId !== check.source.agentId ||
    facts.source.path !== check.source.path ||
    facts.source.databaseIdentity !== check.source.databaseIdentity ||
    facts.source.databaseBirthtime !== check.source.databaseBirthtime ||
    facts.source.sessionKey !== check.source.sessionKey ||
    facts.source.sessionIdLookup !== check.source.sessionIdLookup ||
    facts.source.projection !== check.source.projection
  ) {
    throw new Error("Session currency facts differ from the captured source");
  }
  check.assertCurrent(
    decodeSessionEntryCurrentFacts(facts.entry, check.source.projection === "capability"),
  );
  return { ...request, facts: facts.domainFacts };
}

/** Unwrap the worker's nested reads before evaluating a predicate over the complete cohort. */
export function assertSessionEntriesCurrentAdmission(
  request: SqliteWorkerAdmissionRequest,
  check: SessionEntriesCurrentCheck | undefined,
): SqliteWorkerAdmissionRequest {
  const entries: Array<SessionEntryCurrentFacts | undefined> = [];
  let currentRequest = request;
  for (let index = (check?.sources.length ?? 0) - 1; index >= 0; index -= 1) {
    currentRequest = assertSessionEntryCurrentAdmission(currentRequest, {
      source: check!.sources[index]!,
      assertCurrent: (entry) => {
        entries[index] = entry;
      },
    });
  }
  currentRequest = assertSessionEntryCurrentAdmission(currentRequest, undefined);
  check?.assertCurrent(entries);
  return currentRequest;
}
