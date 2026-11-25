import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createKeyedStateDomainPublication } from "../state/state-domain-publication.js";

export function sessionUpstreamPresenceKey(sessionKey: string, agentId: string): string {
  return JSON.stringify([agentId, sessionKey]);
}

export const sessionUpstreamPresencePublication = createKeyedStateDomainPublication<true>({
  domain: "session-upstream-presence",
  isFact: (_key, fact) =>
    fact.kind === "absent" || (fact.kind === "postimage" && fact.value === true),
});

/** Read preparation subscribes first, so a late read cannot replace a newer committed fact. */
export function observeSessionUpstreamPresence(
  context: OpenClawStateWorkerContext,
  sessionKey: string,
  agentId: string,
) {
  const key = sessionUpstreamPresenceKey(sessionKey, agentId);
  let observed = false;
  let present: boolean | undefined;
  const release = sessionUpstreamPresencePublication.subscribeFacts((change) => {
    if (
      change.kind === "committed" &&
      change.receipt.source.identity === context.admission.identity.key
    ) {
      const fact = change.receipt.facts.get(key);
      if (!fact || fact.kind === "unchanged") {
        return;
      }
      observed = true;
      present = fact.kind === "unknown" ? undefined : fact.kind === "postimage";
    } else if (change.kind === "unknown" && change.identity === context.admission.identity.key) {
      observed = true;
      present = undefined;
    }
  });
  return {
    release,
    seed(value: boolean) {
      if (!observed) {
        present = value;
      }
    },
    current: (): boolean => {
      context.admission.assertCurrent();
      if (present === undefined) {
        throw new Error("Session upstream source is unavailable");
      }
      return present;
    },
  };
}

/** Piggyback presence facts on the owning write's existing commit receipt. */
export function withSessionUpstreamPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    const publication = sessionUpstreamPresencePublication.begin({
      get identity() {
        return context.admission.identity.key;
      },
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
      publishPending: false,
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      if (isRecord(facts) && facts.upstreamPresence !== undefined) {
        publication.committed(facts.upstreamPresence);
      }
    });
    observeSqliteWorkerAdmissionFinish(owner.admission, () => {
      publication.finish(owner.admission.settlement?.kind === "completed", true);
    });
    return owner;
  };
}
