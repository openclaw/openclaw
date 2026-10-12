import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { inlineAuthProfileCredentialSchema } from "../agents/auth-profiles/credential-schema.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "./state-domain-publication.js";
import { parseUserModelAuthProfileId } from "./user-model-account-id.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";

type CredentialFact = {
  id: string;
  credential: AuthProfileCredential;
  replacement: boolean;
};

export const personalCredentialPublication = createStateDomainPublication<CredentialFact>({
  domain: "personal-model-credentials",
  keyOf: (fact) => fact.id,
  isValue: (value): value is CredentialFact =>
    isRecord(value) &&
    typeof value.id === "string" &&
    parseUserModelAuthProfileId(value.id) !== undefined &&
    typeof value.replacement === "boolean" &&
    inlineAuthProfileCredentialSchema.safeParse(value.credential).success,
});

type CredentialCell = {
  credential?: AuthProfileCredential;
  identityCurrent: () => boolean;
};
type CredentialOwner = {
  cells: Map<string, CredentialCell>;
  pending: Set<string>;
  uncertain: boolean;
};
const owners = resolveGlobalMap<string, CredentialOwner>(
  Symbol.for("openclaw.personalCredentialAuthority"),
  "close-and-restart",
);
function ownerFor(identity: string) {
  let owner = owners.get(identity);
  if (!owner) {
    owner = { cells: new Map(), pending: new Set(), uncertain: false };
    owners.set(identity, owner);
  }
  return owner;
}

personalCredentialPublication.subscribeFacts((change) => {
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  if (typeof identity !== "string") {
    return;
  }
  const owner = ownerFor(identity);
  if (change.kind === "pending") {
    owner.pending.add(change.operationId);
  } else if (change.kind === "settled") {
    owner.pending.delete(change.operationId);
  } else if (change.kind === "unknown") {
    owner.uncertain = true;
    owner.cells.clear();
  } else if (change.kind === "committed") {
    for (const [id, fact] of change.receipt.facts) {
      const cell = owner.cells.get(id);
      if (fact.kind !== "postimage") {
        owner.cells.delete(id);
      } else if (cell) {
        // Reconnect never revives a retained grant, even with identical token bytes.
        const next = fact.value.replacement ? { ...cell } : cell;
        next.credential = fact.value.credential;
        owner.cells.set(id, next);
      }
    }
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    if (event.identity) {
      owners.delete(event.identity.key);
    } else {
      owners.clear();
    }
  }
});

/** The existing identity owner fences merge, including every flattened source alias. */
export async function capturePersonalCredentialAuthority(
  context: OpenClawStateWorkerContext,
  profileId: string,
) {
  const locator = parseUserModelAuthProfileId(profileId);
  if (!locator) {
    throw new Error("Personal credential authority requires an exact account ID");
  }
  const identity = context.admission.identity.key;
  const owner = ownerFor(identity);
  const captured = await captureUserProfileAuthorityRead(context.admission, undefined, "identity");
  const identityCurrent = captured.bind(locator.ownerProfileId);
  if (!identityCurrent) {
    throw new Error("Personal model account ownership changed during preparation; retry");
  }
  let cell = owner.cells.get(profileId);
  if (!cell?.identityCurrent()) {
    cell = { identityCurrent };
    owner.cells.set(profileId, cell);
  }
  const retained = cell;
  const assertCurrent = () => {
    if (
      owners.get(identity) !== owner ||
      owner.cells.get(profileId) !== retained ||
      owner.pending.size ||
      owner.uncertain ||
      !retained.identityCurrent()
    ) {
      throw new Error(
        "Personal model account authority is unavailable; retry after owner recovery",
      );
    }
  };
  assertCurrent();
  return {
    observe(credential: AuthProfileCredential | undefined) {
      assertCurrent();
      // A committed postimage wins over a read dispatched before that mutation.
      retained.credential ??= credential && structuredClone(credential);
    },
    readCurrentCredential(this: void) {
      assertCurrent();
      return retained.credential && structuredClone(retained.credential);
    },
  };
}

/** Denial starts before dispatch and survives an unacknowledged native outcome. */
export function withPersonalCredentialPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const retained = createAdmission(operation);
    const { admission } = retained;
    const publication = personalCredentialPublication.begin({
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      publication.committed(isRecord(facts) ? facts.personalCredentials : undefined);
    });
    const finish = admission.finish.bind(admission);
    admission.finish = () => {
      try {
        finish();
      } finally {
        if (admission.settlement) {
          const confirmed = admission.settlement.kind === "completed";
          publication.finish(confirmed, confirmed && !admission.committed);
        }
      }
    };
    void operation.settled.then((outcome) => {
      const known = outcome.kind !== "unknown";
      publication.finish(known, known && !admission.committed);
    });
    return retained;
  };
}
