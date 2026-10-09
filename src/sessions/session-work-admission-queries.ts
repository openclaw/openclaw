import { normalizeSessionIdentities } from "./session-lifecycle-identity.js";

type ReleasableSessionWorkAdmission = {
  phase: "pending" | "acquired";
  owner?: symbol;
  released: Promise<void>;
};

type SessionWorkAdmissionReleaseParams = {
  scope: string;
  identities: Iterable<string | undefined>;
};

/** Read-only queries over the lifecycle owner's live admission index. */
export function createSessionWorkAdmissionQueries<T extends ReleasableSessionWorkAdmission>(
  admissionsByIdentity: ReadonlyMap<string, ReadonlySet<T>>,
  currentAdmissions: () => ReadonlySet<T> | undefined,
) {
  function collectSessionWorkAdmissions(
    identities: Iterable<string>,
    matches: (admission: T) => boolean,
  ): Set<T> {
    const matching = new Set<T>();
    for (const identity of identities) {
      for (const admission of admissionsByIdentity.get(identity) ?? []) {
        if (matches(admission)) {
          matching.add(admission);
        }
      }
    }
    return matching;
  }

  function sessionWorkAdmissionRelease(
    params: SessionWorkAdmissionReleaseParams,
    matches: (admission: T) => boolean,
  ): Promise<void> | undefined {
    const admissions = collectSessionWorkAdmissions(
      normalizeSessionIdentities(params.scope, params.identities),
      matches,
    );
    // One turn may hold outer and inner admissions; wait for every captured owner.
    return admissions.size > 0
      ? Promise.all(Array.from(admissions, (admission) => admission.released)).then(() => undefined)
      : undefined;
  }

  /** Completion of the currently active turns that own a session. */
  function getSessionWorkAdmissionRelease(
    params: SessionWorkAdmissionReleaseParams,
  ): Promise<void> | undefined {
    return sessionWorkAdmissionRelease(params, (admission) => admission.phase === "acquired");
  }

  /** Completion of a named owner that is starting or actively working on a session. */
  function getSessionWorkAdmissionOwnerRelease(
    params: SessionWorkAdmissionReleaseParams & { owner: symbol },
  ): Promise<void> | undefined {
    return sessionWorkAdmissionRelease(params, (admission) => admission.owner === params.owner);
  }

  /** Wait for exact prior owners, including queued work, without waiting on inherited admission. */
  function getCompetingSessionWorkAdmissionRelease(
    params: SessionWorkAdmissionReleaseParams & { excludePendingOwner?: symbol },
  ): Promise<void> | undefined {
    const current = currentAdmissions();
    return sessionWorkAdmissionRelease(
      params,
      (admission) =>
        !current?.has(admission) &&
        !(
          params.excludePendingOwner !== undefined &&
          admission.phase === "pending" &&
          admission.owner === params.excludePendingOwner
        ),
    );
  }

  return {
    collectSessionWorkAdmissions,
    getSessionWorkAdmissionRelease,
    getSessionWorkAdmissionOwnerRelease,
    getCompetingSessionWorkAdmissionRelease,
  };
}
