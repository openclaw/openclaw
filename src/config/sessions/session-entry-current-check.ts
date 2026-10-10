import { isDeepStrictEqual } from "node:util";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { resolveCurrentConversationSession } from "./conversation-registry.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionEntryCurrentFacts } from "./session-entry-current.types.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
} from "./session-entry-read-request.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";
import type { SessionSourceAssertion, SessionSourceCheck } from "./session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

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
export async function captureSessionEntryCurrentCheckInternal(inputParams: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Live channel/run facts only; persisted routing belongs in the alternatives below. */
  isActive?: () => boolean;
  matchGeneration?: boolean;
  /** Exact policy fields retained alongside the returned entry. */
  fields?: readonly (keyof SessionEntryCurrentFacts & keyof SessionEntry)[];
  /** Refuse preparation when a previously selected entry no longer matches. */
  expected?: Partial<SessionEntry>;
  alternatives?: readonly {
    conversations: readonly ConversationCondition[];
    isActive?: () => boolean;
  }[];
  errorMessage?: string;
}): Promise<{
  entry: SessionEntry | undefined;
  isCurrent: () => boolean;
  assertCurrent: () => void;
}> {
  const params = { ...inputParams };
  const incognito = captureIncognitoSessionSource(params);
  const storePath = incognito
    ? "kind" in incognito
      ? incognito.path
      : incognito.actor.path
    : (params.storePath ?? resolveSessionStorePathForScope(params));
  const input = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath,
    projection: params.fields ? undefined : ("list" as const),
    env: params.env,
  };
  const captured =
    incognito && "kind" in incognito
      ? { scope: { ...input, env: incognito.env }, agentId: incognito.agentId }
      : captureSessionEntryReadScope(input);
  const scope = { ...captured.scope, storePath: captured.scope.storePath ?? storePath };
  const fields = [
    ...new Set([
      ...(params.matchGeneration === false ? [] : (["sessionId", "lifecycleRevision"] as const)),
      ...(params.fields ?? []),
    ]),
  ];
  const expected = params.expected && structuredClone(params.expected);
  const inputCandidates =
    incognito || isNativeSessionEntryRead(scope, captured.agentId)
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
    const selected = read.value;
    const selectedValues = fields.map((field) => structuredClone(selected?.[field]));
    if (
      expected &&
      (!selected || fields.some((field) => !isDeepStrictEqual(selected[field], expected[field])))
    ) {
      refuse();
    }
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
    const identity = incognito ? undefined : readDatabasePathIdentitySync(target.storePath);
    const claim =
      incognito && !("kind" in incognito)
        ? incognito.actor.sessions.captureCurrent(target.sessionKey)
        : undefined;
    const selectedStore = owner.selectedStore;
    const native = owner.kind === "native";
    const sourceIsCurrent = () => {
      if (incognito) {
        incognito.admissionSignal?.throwIfAborted();
        if ("kind" in incognito) {
          incognito.assertCurrent();
        } else {
          incognito.actor.assertReadable();
          claim!.assertCurrent();
        }
        return true;
      }
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
          !identity?.key.startsWith("file:") ||
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
      if (fields.length > 0) {
        const current = incognito
          ? "kind" in incognito
            ? undefined
            : incognito.actor.sessions.readCapability(target.sessionKey)
          : loadSessionEntryReadOnly(readScope);
        if (
          (current === undefined) !== (selected === undefined) ||
          fields.some((field, index) => !isDeepStrictEqual(current?.[field], selectedValues[index]))
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
      incognito ||
      native ||
      !identity?.key.startsWith("file:") ||
      alternatives.some((alternative) =>
        alternative.conversations.some(
          ({ locator }) => locator.physicalPath !== identity?.canonicalPath,
        ),
      );
    const source: SessionSourceAssertion =
      !identity || nativeSource
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
            fields,
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
                    if (
                      (!matches || matches.includes(index)) &&
                      alternative.isActive?.() !== false
                    ) {
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
    if (params.fields || incognito) {
      assertCurrent();
    }
    return { entry: selected, isCurrent: check, assertCurrent: source };
  });
}
