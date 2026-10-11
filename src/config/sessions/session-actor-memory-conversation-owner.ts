import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConversationIdentity } from "./conversation-identity.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import {
  cloneSessionActorMemoryConversations,
  type SessionActorMemoryConversationOwner,
  type SessionActorMemoryConversationQuery,
  type SessionActorMemoryConversationCommand,
  type SessionActorMemoryConversationReads,
  type SessionActorMemoryConversationWrites,
  type SessionActorMemoryConversationRegistration,
} from "./session-actor-memory-conversation-contract.js";
import {
  readSessionActorMemoryConversationDelivery,
  beginSessionActorMemoryConversationDelivery,
  transitionSessionActorMemoryConversationDelivery,
} from "./session-actor-memory-conversation-delivery.js";
import {
  readSessionActorMemoryConversation,
  writeSessionActorMemoryConversation,
} from "./session-actor-memory-conversation.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";

/** The agent actor's catalogue outlives individual sessions, so it needs no synthetic session handle. */
export function createSessionActorMemoryConversationOwner(options: {
  conversations(): SessionActorMemoryConversationOwner;
  installConversations(value: SessionActorMemoryConversationOwner): void;
  entries(): IterableIterator<[string, SessionActorMemoryState]>;
  get(key: string): SessionActorMemoryState | undefined;
  enqueue<T>(run: () => T): Promise<T>;
  assertCurrent(): void;
}) {
  const transaction = (
    authority: SessionActorAuthority,
    selectEligible?: (identities: readonly ConversationIdentity[]) => readonly boolean[],
  ) => {
    options.assertCurrent();
    let changed: SessionActorMemoryConversationOwner | undefined;
    const authorized = new Set<string>();
    const context = {
      get conversations() {
        return changed ?? options.conversations();
      },
      editConversations() {
        return (changed ??= cloneSessionActorMemoryConversations(options.conversations()));
      },
      entries: options.entries,
      get(key: string) {
        const state = options.get(key);
        if (state && !authorized.has(key)) {
          authority.authorize("commit", structuredClone(state.hot));
          authorized.add(key);
        }
        return state;
      },
      admit(_stage: "transaction" | "commit", publication?: unknown) {
        if (
          selectEligible &&
          isRecord(publication) &&
          publication.kind === "session.conversation.registration"
        ) {
          // SAFETY: The paired registration command publishes this closed eligibility request.
          const registration = publication as SessionActorMemoryConversationRegistration;
          registration.eligible = selectEligible(structuredClone(registration.identities));
        }
      },
    };
    return {
      context,
      commit() {
        if (changed) {
          options.installConversations(changed);
        }
      },
    };
  };
  function readConversation<Key extends keyof SessionActorMemoryConversationReads>(
    query: { type: Key; input: SessionActorMemoryConversationReads[Key]["input"] },
    authority: SessionActorAuthority,
  ): SessionActorMemoryConversationReads[Key]["output"] {
    const { context } = transaction(authority);
    // SAFETY: The generic query key and input select the same closed conversation variant.
    const command = query as SessionActorMemoryConversationQuery;
    const value =
      command.type === "session.conversation.delivery.read"
        ? readSessionActorMemoryConversationDelivery(context, command.input)
        : readSessionActorMemoryConversation(context, command);
    authority.assertCurrent();
    // SAFETY: The query key, input and dispatch output are paired by the closed domain contract.
    return structuredClone(value) as SessionActorMemoryConversationReads[Key]["output"];
  }
  return {
    readConversation,
    readConversationAfterWrites<Key extends keyof SessionActorMemoryConversationReads>(
      query: { type: Key; input: SessionActorMemoryConversationReads[Key]["input"] },
      authority: SessionActorAuthority,
    ): Promise<SessionActorMemoryConversationReads[Key]["output"]> {
      const captured = structuredClone(query);
      return options.enqueue(() => readConversation(captured, authority));
    },
    mutateConversation<Key extends keyof SessionActorMemoryConversationWrites>(
      command: { type: Key; input: SessionActorMemoryConversationWrites[Key]["input"] },
      authority: SessionActorAuthority,
      selectEligible?: (identities: readonly ConversationIdentity[]) => readonly boolean[],
    ): Promise<SessionActorMemoryConversationWrites[Key]["output"]> {
      // SAFETY: Cloning preserves the command key and its paired input variant.
      const captured = structuredClone(command) as SessionActorMemoryConversationCommand;
      return options.enqueue(() => {
        const { context, commit } = transaction(authority, selectEligible);
        const value =
          captured.type === "session.conversation.delivery.begin"
            ? beginSessionActorMemoryConversationDelivery(context, captured.input)
            : captured.type === "session.conversation.delivery.transition"
              ? transitionSessionActorMemoryConversationDelivery(context, captured.input)
              : writeSessionActorMemoryConversation(context, captured);
        options.assertCurrent();
        authority.assertCurrent();
        const detached = structuredClone(value);
        commit();
        // SAFETY: The command key, input and dispatch output are paired by the closed domain contract.
        return detached as SessionActorMemoryConversationWrites[Key]["output"];
      });
    },
  };
}
