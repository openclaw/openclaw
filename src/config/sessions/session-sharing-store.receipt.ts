import { isDeepStrictEqual, toUSVString } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { SessionParticipantSchema } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import {
  hasSqliteCommitReceiptCoverage,
  type SqliteCommittedFact,
} from "../../infra/sqlite-commit-receipt.js";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionCollaborationFact,
  SessionSharingCommitReceipt,
  SessionSharingWorkerOperations,
} from "./session-sharing-store.types.js";

const participant = lazyCompile(SessionParticipantSchema);

function requireReceipt(condition: unknown): asserts condition {
  if (!condition) {
    throw new SqliteWorkerError(
      "Session collaboration receipt is incomplete or conflicting",
      "outcome-unknown",
    );
  }
}

function storedSuggestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.authorId === "string" &&
    (value.authorLabel === undefined || typeof value.authorLabel === "string") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.state === "string" &&
    ["pending", "accepted", "dismissed"].includes(value.state)
  );
}

/** The native commit grant pins this candidate, including its committing connection incarnation. */
export function readSessionCollaborationCandidate(
  value: unknown,
  command: SqliteWorkerCommand<SessionSharingWorkerOperations>,
  keys: readonly string[],
  databaseIdentity: string,
): SessionSharingCommitReceipt {
  requireReceipt(
    isRecord(value) &&
      value.kind === "session-collaboration-committed" &&
      value.type === command.type &&
      Object.hasOwn(value, "result") &&
      isRecord(value.publication) &&
      isRecord(value.publication.source) &&
      value.publication.source.identity === databaseIdentity &&
      typeof value.publication.source.incarnation === "string" &&
      value.publication.source.incarnation.length > 0,
  );
  requireReceipt(
    hasSqliteCommitReceiptCoverage(value.publication, {
      source: { identity: databaseIdentity, incarnation: value.publication.source.incarnation },
      domain: "session-collaboration",
      keys,
    }),
  );
  const expected = new Map<string, SqliteCommittedFact<readonly SessionCollaborationFact[]>>(
    keys.map((key) => [key, { kind: "unchanged" }]),
  );
  const setFact = (key: string, fact: SessionCollaborationFact) => {
    requireReceipt(expected.has(key));
    expected.set(key, { kind: "postimage", value: [fact] });
  };
  const result = value.result;
  const key = command.input.scope.sessionKey;
  if (command.type !== "category.apply") {
    requireReceipt(keys.length === 1 && keys[0] === key);
  }
  switch (command.type) {
    case "add":
    case "remove": {
      requireReceipt(isRecord(result));
      const adding = command.type === "add";
      if (adding) {
        requireReceipt(isRecord(result.value) && typeof result.value.inserted === "boolean");
      }
      const member = adding && isRecord(result.value) ? result.value.member : result.value;
      const changed = adding && isRecord(result.value) ? result.value.inserted : member !== null;
      const identityId = adding
        ? command.input.params.identityId.trim()
        : command.input.identityId.trim();
      if (member !== null) {
        requireReceipt(
          isRecord(member) &&
            member.identityId === (adding ? identityId : toUSVString(identityId)) &&
            typeof member.addedBy === "string" &&
            typeof member.addedAt === "number" &&
            Number.isFinite(member.addedAt),
        );
        if (command.type === "add") {
          requireReceipt(
            member.addedBy === command.input.params.addedBy.trim() &&
              (command.input.params.addedAt === undefined ||
                member.addedAt === command.input.params.addedAt),
          );
        } else if (command.input.expected) {
          requireReceipt(
            member.addedBy === command.input.expected.addedBy &&
              member.addedAt === command.input.expected.addedAt,
          );
        }
      } else {
        requireReceipt(!adding);
      }
      if (changed) {
        const facts = result.facts;
        const sessionId =
          command.type === "add"
            ? command.input.params.expectedSessionId
            : command.input.expectedSessionId;
        requireReceipt(
          isRecord(facts) &&
            typeof facts.sessionId === "string" &&
            (sessionId === undefined || sessionId === facts.sessionId),
        );
        const fact: SessionCollaborationFact = {
          kind: "member",
          sessionId: facts.sessionId,
          identityId: toUSVString(identityId),
          present: adding,
        };
        requireReceipt(isDeepStrictEqual(facts, fact));
        setFact(key, fact);
      } else {
        requireReceipt(result.facts === undefined);
      }
      break;
    }
    case "owner.assign": {
      requireReceipt(isRecord(result));
      if (result.value === null) {
        requireReceipt(result.facts === undefined);
      } else {
        const { params } = command.input;
        requireReceipt(
          isRecord(result.value) &&
            typeof result.value.assignedAt === "number" &&
            Number.isFinite(result.value.assignedAt),
        );
        const owner = {
          actor: params.owner,
          assignedBy: params.assignedBy,
          assignedAt: params.assignedAt ?? result.value.assignedAt,
        };
        requireReceipt(isDeepStrictEqual(result.value, owner));
        const facts = result.facts;
        requireReceipt(
          isRecord(facts) &&
            typeof facts.sessionId === "string" &&
            (params.expectedSessionId === undefined ||
              facts.sessionId === params.expectedSessionId) &&
            (facts.lifecycleRevision === null || typeof facts.lifecycleRevision === "string"),
        );
        const fact: SessionCollaborationFact = {
          kind: "owner",
          sessionId: facts.sessionId,
          lifecycleRevision: facts.lifecycleRevision,
          owner,
        };
        requireReceipt(isDeepStrictEqual(facts, fact));
        setFact(key, fact);
      }
      break;
    }
    case "participant": {
      requireReceipt(
        isRecord(result) &&
          (result.value === null ||
            result.value === "inserted" ||
            result.value === "updated" ||
            result.value === "capped") &&
          typeof result.projectionChanged === "boolean" &&
          isRecord(result.participants),
      );
      const projection = result.participants;
      let projected: Extract<SessionCollaborationFact, { kind: "participants" }>["projection"] = {};
      if (projection.participants !== undefined) {
        requireReceipt(
          Array.isArray(projection.participants) &&
            projection.participants.every(participant) &&
            projection.participantCount === projection.participants.length,
        );
        projected = {
          participants: projection.participants,
          participantCount: projection.participants.length,
        };
      } else {
        requireReceipt(projection.participantCount === undefined);
      }
      requireReceipt(isDeepStrictEqual(projection, projected));
      if (result.projectionChanged) {
        requireReceipt(result.value === "inserted" || result.value === "updated");
        setFact(key, { kind: "participants", projection: projected });
      }
      break;
    }
    case "category.apply": {
      requireReceipt(Array.isArray(result) && result.length === keys.length);
      const seen = new Set<string>();
      for (const row of result) {
        requireReceipt(
          isRecord(row) &&
            typeof row.sessionKey === "string" &&
            typeof row.sessionId === "string" &&
            !seen.has(row.sessionKey),
        );
        seen.add(row.sessionKey);
        setFact(row.sessionKey, {
          kind: "category",
          sessionId: row.sessionId,
          category: command.input.to?.trim() || null,
        });
      }
      break;
    }
    case "involvement":
      requireReceipt(
        isRecord(result) &&
          typeof result.accepted === "boolean" &&
          typeof result.changed === "boolean" &&
          (!result.changed || result.accepted),
      );
      if (result.changed) {
        setFact(key, { kind: "unchanged" });
      }
      break;
    case "suggestion.add":
      requireReceipt(
        storedSuggestion(result) &&
          isRecord(result) &&
          result.id === command.input.params.id &&
          result.authorId === command.input.params.authorId.trim() &&
          result.text === command.input.params.text &&
          result.createdAt === command.input.params.createdAt &&
          result.state === "pending",
      );
      break;
    case "suggestion.finalize":
      requireReceipt(
        result === null ||
          (storedSuggestion(result) &&
            isRecord(result) &&
            result.id === toUSVString(command.input.params.id) &&
            result.state === command.input.params.state),
      );
      break;
    case "suggestion.release":
      requireReceipt(typeof result === "boolean");
      break;
    case "suggestion.claim":
      requireReceipt(
        result === null ||
          (isRecord(result) &&
            (result.kind === "busy" ||
              (result.kind === "mismatch" &&
                typeof result.resolution === "string" &&
                ["send", "queue", "edit", "dismiss"].includes(result.resolution)) ||
              (result.kind === "claimed" &&
                typeof result.token === "string" &&
                result.token.length > 0 &&
                storedSuggestion(result.suggestion) &&
                isRecord(result.suggestion) &&
                result.suggestion.id === toUSVString(command.input.params.id)))),
      );
      break;
    case "category.prepare":
      requireReceipt(false);
  }
  requireReceipt(isDeepStrictEqual(value.publication.facts, expected));
  // SAFETY: The envelope, command-specific result fields, and exact postimage map were validated above.
  return value as SessionSharingCommitReceipt;
}
