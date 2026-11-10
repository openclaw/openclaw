import type { SqliteCommittedFact } from "../../infra/sqlite-commit-receipt.js";
import { resolveDatabasePathKey } from "../../infra/sqlite-worker-identity.js";
import type { ConversationBindingSnapshot } from "./conversation-binding-facts.types.js";
import {
  conversationPublication,
  readStagedConversationPublications,
  type ConversationFact,
  type ConversationFactChange,
  type ConversationPublication,
} from "./session-accessor.sqlite-conversation-publication.js";

const factKey = (...parts: string[]) => JSON.stringify(parts);

function applyFacts(
  facts: Map<string, ConversationFact>,
  changes: ReadonlyMap<string, SqliteCommittedFact<ConversationFact>>,
) {
  for (const [key, fact] of changes) {
    if (fact.kind === "absent") {
      const previous = facts.get(key);
      facts.delete(key);
      if (previous?.kind === "window") {
        for (const [candidateKey, candidate] of facts) {
          if (
            candidate.kind === "association" &&
            candidate.row.session_id === previous.row.session_id
          ) {
            facts.delete(candidateKey);
          }
        }
      }
    } else if (fact.kind === "postimage") {
      if (fact.value.kind === "rehome") {
        const move = fact.value;
        for (const [windowKey, window] of facts) {
          if (
            window.kind === "window" &&
            (window.row.session_id === move.sessionId ||
              move.previousKeys?.includes(window.row.session_key))
          ) {
            facts.set(windowKey, {
              kind: "window",
              row: { ...window.row, session_key: move.sessionKey },
            });
          }
        }
      } else {
        facts.set(key, fact.value);
      }
    }
  }
}

/** A request-scoped projection of the publication owner, retaining every possible winner. */
export function retainConversationBindingFacts(
  conversationRefs: readonly string[],
  databasePath: string,
) {
  const databasePathKey = resolveDatabasePathKey(databasePath);
  const refs = new Set(conversationRefs);
  let facts = new Map<string, ConversationFact>();
  let source: ConversationBindingSnapshot["source"];
  let known = true;
  let acquiring = true;
  let active = true;
  const queued: ConversationFactChange[] = [];
  const pending = new Set<object>();
  const sameSource = (receipt: Pick<ConversationPublication, "source">) =>
    source
      ? receipt.source.identity === source.identity
      : receipt.source.canonicalPath === databasePathKey;
  const relevant = (receipt: ConversationPublication) =>
    [...receipt.facts].some(
      ([key, fact]) =>
        facts.has(key) ||
        (fact.kind === "postimage" &&
          (fact.value.kind === "catalogue" || fact.value.kind === "association"
            ? refs.has(fact.value.row.conversation_id)
            : fact.value.kind === "rehome")),
    );
  const receive = (change: ConversationFactChange) => {
    if (acquiring) {
      queued.push(change);
      return;
    }
    if ("facts" in change) {
      if (!sameSource(change)) {
        return;
      }
      // An absent store has only its captured path until its first committed publication.
      source ??= change.source;
      if ([...change.facts.values()].some((fact) => fact.kind === "unknown")) {
        known = false;
      }
      applyFacts(facts, change.facts);
    } else if (change.kind === "unknown") {
      if (sameSource(change)) {
        known = false;
      }
    } else if (change.kind === "pending") {
      if (
        (source
          ? change.databaseIdentity === source.identity
          : change.databasePath === databasePathKey) &&
        (change.receipts === undefined || change.receipts.some(relevant))
      ) {
        pending.add(change.operation);
      }
    } else if (pending.delete(change.operation) && change.outcome === "unknown") {
      known = false;
    }
  };
  const prune = () => {
    const sessions = new Set<string>();
    const nodes = new Set<string>();
    for (const fact of facts.values()) {
      if (fact.kind === "association" && refs.has(fact.row.conversation_id)) {
        sessions.add(fact.row.session_id);
      }
    }
    for (const fact of facts.values()) {
      if (fact.kind === "window" && sessions.has(fact.row.session_id)) {
        nodes.add(fact.row.session_key);
      }
    }
    for (const [key, fact] of facts) {
      const keep =
        fact.kind === "catalogue" || fact.kind === "association"
          ? refs.has(fact.row.conversation_id)
          : fact.kind === "window"
            ? sessions.has(fact.row.session_id)
            : fact.kind === "node" && nodes.has(fact.row.session_key);
      if (!keep) {
        facts.delete(key);
      }
    }
  };
  const unsubscribe = conversationPublication.subscribeFacts(receive);
  const unsubscribeObservers = conversationPublication.subscribe(prune);
  return {
    acknowledge(snapshot: ConversationBindingSnapshot) {
      source = snapshot.source;
      const initial = new Map<string, SqliteCommittedFact<ConversationFact>>();
      for (const row of snapshot.catalogues) {
        initial.set(factKey("catalogue", row.conversation_id), {
          kind: "postimage",
          value: { kind: "catalogue", row },
        });
      }
      for (const row of snapshot.associations) {
        initial.set(factKey("association", row.session_id, row.conversation_id, row.role), {
          kind: "postimage",
          value: { kind: "association", row },
        });
      }
      for (const row of snapshot.windows) {
        initial.set(factKey("window", row.session_id), {
          kind: "postimage",
          value: { kind: "window", row },
        });
      }
      for (const row of snapshot.nodes) {
        initial.set(factKey("node", row.session_key), {
          kind: "postimage",
          value: { kind: "node", row },
        });
      }
      facts = new Map();
      applyFacts(facts, initial);
      acquiring = false;
      for (const change of queued) {
        receive(change);
      }
      queued.length = 0;
      prune();
    },
    currentSessionKey(conversationRef: string): string | null {
      if (!active || !known || acquiring || pending.size) {
        throw new Error("Conversation binding publication is unavailable");
      }
      const staged = readStagedConversationPublications().filter(sameSource);
      const current = staged.length ? new Map(facts) : facts;
      // Managed native transactions expose tentative writes only to their synchronous owner.
      for (const receipt of staged) {
        applyFacts(current, receipt.facts);
      }
      const catalogue = current.get(factKey("catalogue", conversationRef));
      if (
        catalogue?.kind !== "catalogue" ||
        !["channel", "direct", "group"].includes(catalogue.row.kind)
      ) {
        return null;
      }
      let selected: { key: string; seen: number; updated: number } | undefined;
      for (const fact of current.values()) {
        if (fact.kind !== "association" || fact.row.conversation_id !== conversationRef) {
          continue;
        }
        const association = fact.row;
        const window = current.get(factKey("window", association.session_id));
        if (window?.kind !== "window") {
          continue;
        }
        const node = current.get(factKey("node", window.row.session_key));
        if (
          node?.kind !== "node" ||
          node.row.entry_valid !== 1 ||
          node.row.current_session_id !== association.session_id ||
          node.row.entry_session_id !== association.session_id ||
          !(
            association.role === "participant" ||
            (association.role === "primary" &&
              window.row.primary_conversation_id === conversationRef)
          )
        ) {
          continue;
        }
        if (
          !selected ||
          association.last_seen_at > selected.seen ||
          (association.last_seen_at === selected.seen && node.row.updated_at > selected.updated)
        ) {
          selected = {
            key: node.row.session_key,
            seen: association.last_seen_at,
            updated: node.row.updated_at,
          };
        }
      }
      return selected?.key ?? null;
    },
    release() {
      active = false;
      unsubscribe();
      unsubscribeObservers();
      facts.clear();
      queued.length = 0;
    },
  };
}
