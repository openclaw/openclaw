import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { resolveCurrentConversationSession } from "./conversation-registry.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
} from "./session-entry-read-request.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import type { SessionSourceAssertion, SessionSourceCheck } from "./session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";

type ConversationCondition = {
  agentId?: string;
  storePath?: string;
  channel: string;
  accountId: string;
  kind: "channel" | "direct" | "group";
  peerId: string;
  threadId?: string;
  sessionKey: string | null;
};

/** Capture a generation and routing choice; acquire worker source custody only for each write. */
export async function captureSessionEntryCurrentCheck(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Live channel/run facts only; persisted routing belongs in the alternatives below. */
  isActive?: () => boolean;
  matchGeneration?: boolean;
  alternatives?: readonly {
    conversations: readonly ConversationCondition[];
    isActive?: () => boolean;
  }[];
  errorMessage?: string;
}): Promise<{ isCurrent: () => boolean; assertCurrent: () => void }> {
  const storePath = params.storePath ?? resolveSessionStorePathForScope(params);
  const captured = captureSessionEntryReadScope({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath,
    projection: "list",
    env: params.env,
  });
  const scope = { ...captured.scope, storePath: captured.scope.storePath ?? storePath };
  const inputCandidates = isNativeSessionEntryRead(scope, captured.agentId)
    ? []
    : captureSessionStoreReadCandidates(scope.storePath);
  const refuse = (): never => {
    throw new Error(
      params.errorMessage ?? "The selected session changed before its operation committed.",
    );
  };
  const assertActive = () => {
    if (params.isActive?.() === false) {
      refuse();
    }
  };
  const alternatives = (params.alternatives ?? [{ conversations: [] }]).map((alternative) => ({
    isActive: alternative.isActive,
    conversations: alternative.conversations.map((condition) => {
      const identity = buildConversationIdentity({
        ...condition,
        deliveryTarget: condition.peerId,
      });
      if (!identity) {
        throw new Error("Session currentness requires a valid conversation address");
      }
      const conversationStorePath = condition.storePath ?? scope.storePath;
      const locator = captureSessionStoreReadCandidate(
        resolveUnsuffixedSqliteTargetFromSessionStorePath(conversationStorePath).path,
      );
      return {
        scope: {
          agentId: condition.agentId ?? params.agentId,
          storePath: conversationStorePath,
          env: scope.env,
        },
        locator,
        predicate: { conversationRef: identity.conversationRef, sessionKey: condition.sessionKey },
      };
    }),
  }));
  return withSessionEntryReadOnlyInWorker(scope, assertActive, async (read, owner) => {
    if (!read.ok) {
      throw read.error;
    }
    const selected = read.value
      ? { sessionId: read.value.sessionId, lifecycleRevision: read.value.lifecycleRevision }
      : undefined;
    const readScope = owner.scope ?? scope;
    const target = {
      agentId: readScope.agentId ?? params.agentId,
      sessionKey: resolveSqliteSessionKey(
        readScope.sessionKey,
        readScope.agentId ?? params.agentId,
      ),
      storePath: owner.scope?.storePath ?? scope.storePath,
      env: scope.env,
    };
    const identity = readDatabasePathIdentitySync(target.storePath);
    const selectedStore = owner.selectedStore;
    const native = owner.kind === "native";
    const sourceIsCurrent = () => {
      if (native) {
        return true;
      }
      try {
        if (
          inputCandidates.some((candidate) => !isSessionStoreReadCandidateCurrent(candidate)) ||
          alternatives.some((alternative) =>
            alternative.conversations.some(
              ({ locator }) => !isSessionStoreReadCandidateCurrent(locator),
            ),
          ) ||
          (selectedStore &&
            assertSessionStoreReadCandidate(selectedStore.path, inputCandidates) !==
              selectedStore.physicalPath)
        ) {
          return false;
        }
        const current = readDatabasePathIdentitySync(target.storePath);
        return (
          !identity.key.startsWith("file:") ||
          (current.key === identity.key && current.birthtime === identity.birthtime)
        );
      } catch {
        return false;
      }
    };
    const check: SessionSourceCheck = () => {
      if (params.isActive?.() === false || !sourceIsCurrent()) {
        return false;
      }
      if (params.matchGeneration !== false) {
        const current = loadSessionEntryReadOnly(readScope);
        if (
          current?.sessionId !== selected?.sessionId ||
          current?.lifecycleRevision !== selected?.lifecycleRevision
        ) {
          return false;
        }
      }
      return alternatives.some(
        (alternative) =>
          alternative.isActive?.() !== false &&
          alternative.conversations.every(
            ({ scope: conversationScope, predicate }) =>
              (resolveCurrentConversationSession(conversationScope, predicate.conversationRef)
                ?.sessionKey ?? null) === predicate.sessionKey,
          ),
      );
    };
    const assertCurrent = () => {
      if (!check()) {
        refuse();
      }
    };
    // Pending publishers have no persistent target; incognito keeps its existing adapter.
    const nativeSource =
      native ||
      !identity.key.startsWith("file:") ||
      alternatives.some((alternative) =>
        alternative.conversations.some(
          ({ locator }) => locator.physicalPath !== identity.canonicalPath,
        ),
      );
    const source: SessionSourceAssertion = nativeSource
      ? Object.assign(assertCurrent, { nativeSource: true })
      : captureSessionEntrySourceAssertion({
          scope: target,
          readSource: {
            agentId: owner.scope?.databaseAgentId ?? params.agentId,
            path: identity.canonicalPath,
            databaseIdentity: identity.key.slice("file:".length),
            databaseBirthtime: identity.birthtime,
          },
          expected: selected,
          fields: params.matchGeneration === false ? [] : ["sessionId", "lifecycleRevision"],
          assertCurrent,
          assertHostCurrent: () => {
            assertActive();
            if (!sourceIsCurrent()) {
              refuse();
            }
          },
          async prepareConversations(readConversations) {
            const predicates = alternatives.map((alternative) =>
              alternative.conversations.map(({ predicate }) => predicate),
            );
            const refs = [
              ...new Set(
                predicates.flatMap((alternative) =>
                  alternative.map(({ conversationRef }) => conversationRef),
                ),
              ),
            ];
            const rows = await readConversations(refs);
            if (
              !alternatives.some(
                (alternative, index) =>
                  alternative.isActive?.() !== false &&
                  predicates[index]!.every(
                    (predicate) =>
                      (rows.get(predicate.conversationRef) ?? null) === predicate.sessionKey,
                  ),
              )
            ) {
              refuse();
            }
            let matches: readonly number[] | undefined;
            const accepted: number[] = [];
            return {
              alternatives: predicates,
              acceptMatches: (validated) => {
                matches = validated;
                accepted.length = 0;
                return accepted;
              },
              assertCurrent: () => {
                assertActive();
                accepted.length = 0;
                for (const [index, alternative] of alternatives.entries()) {
                  if ((!matches || matches.includes(index)) && alternative.isActive?.() !== false) {
                    accepted.push(index);
                  }
                }
                if (accepted.length === 0) {
                  refuse();
                }
              },
            };
          },
          refuse,
        });
    check.sessionSource = source;
    owner.assertCurrent();
    return { isCurrent: check, assertCurrent: source };
  });
}
