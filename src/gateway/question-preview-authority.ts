import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { usesOwnRunQuestionAccess } from "./question-access.js";
import type { QuestionObservation } from "./question-manager.js";
import type { PreparedQuestionSession } from "./question-session-access.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";

export function questionPreviewAuthority(
  observation: QuestionObservation | null,
  prepared: PreparedQuestionSession | undefined,
  record: QuestionRecord | undefined,
): GatewayBroadcastOpts["questionPreview"] {
  const target = prepared?.target;
  const identity = prepared?.read.result.databaseIdentity;
  if (
    !prepared ||
    !record ||
    !observation?.ordinary ||
    !observation.sessionAccess ||
    !target?.entry.sessionId ||
    !target.entry.lifecycleRevision ||
    target.entry.incognito ||
    isIncognitoSessionKey(target.canonicalKey) ||
    record.sessionKey !== target.canonicalKey ||
    record.agentId !== target.agentId ||
    !identity
  ) {
    return undefined;
  }
  const original = {
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
    sessionId: target.entry.sessionId,
    lifecycleRevision: target.entry.lifecycleRevision,
    databasePath: prepared.read.database.path,
    databaseIdentity: identity.identity,
    databaseBirthtime: identity.birthtime,
  };
  const isPending = () =>
    observation.isCurrent() &&
    observation.record === record &&
    record.status === "pending" &&
    record.expiresAtMs > Date.now();
  if (!isPending()) {
    return undefined;
  }
  return {
    record,
    canPreview(client, current) {
      try {
        // Session preparation expires after fanout. Retain only identity facts
        // and the question owner's original source observation across push awaits.
        observation.refreshRequester();
        observation.sessionAccess?.assertSourceCurrent();
        if (
          !isPending() ||
          client.invalidated ||
          usesOwnRunQuestionAccess(client) ||
          current?.agentId !== original.agentId ||
          current.canonicalKey !== original.sessionKey ||
          current.storePath !== original.storePath ||
          current.entry.sessionId !== original.sessionId ||
          current.entry.lifecycleRevision !== original.lifecycleRevision ||
          current.entry.incognito ||
          current.readSource?.path !== original.databasePath ||
          current.readSource.databaseIdentity !== original.databaseIdentity ||
          current.readSource.databaseBirthtime !== original.databaseBirthtime
        ) {
          return false;
        }
        return (
          (!observation.authorizeClient || observation.authorizeClient(client, current)) &&
          isPending()
        );
      } catch {
        return false;
      }
    },
  };
}
