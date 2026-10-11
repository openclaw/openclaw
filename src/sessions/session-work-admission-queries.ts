import {
  collectSessionIdentityTargets,
  normalizeSessionIdentities,
} from "./session-lifecycle-identity.js";

type ReleasableSessionWorkAdmission = {
  phase: "pending" | "acquired";
  owner?: symbol;
  released: Promise<void>;
  isSettling?: () => boolean;
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

  function isSessionWorkAdmissionActive(
    scope: string,
    identities: Iterable<string | undefined>,
  ): boolean {
    return normalizeSessionIdentities(scope, identities).some((identity) =>
      [...(admissionsByIdentity.get(identity) ?? [])].some(
        (admission) => admission.phase === "acquired",
      ),
    );
  }

  /** Active session identities grouped by their authoritative store/lifecycle scope. */
  function collectActiveSessionWorkAdmissions(
    owners?: ReadonlySet<object>,
  ): Map<string, Set<string>> {
    const identities = [...admissionsByIdentity]
      .filter(([, admissions]) =>
        [...admissions].some(
          (admission) => admission.phase === "acquired" && (!owners || owners.has(admission)),
        ),
      )
      .map(([identity]) => identity);
    return collectSessionIdentityTargets(identities);
  }

  /** Unique admitted turns; one lease can be indexed under several identities. */
  function getActiveSessionWorkAdmissionCount(): number {
    return collectSessionWorkAdmissions(
      admissionsByIdentity.keys(),
      (admission) => admission.phase === "acquired",
    ).size;
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
    params: SessionWorkAdmissionReleaseParams & { owner: symbol; phase?: "acquired" },
  ): Promise<void> | undefined {
    return sessionWorkAdmissionRelease(
      params,
      (admission) =>
        admission.owner === params.owner && (!params.phase || admission.phase === params.phase),
    );
  }

  /** Wait for exact prior owners, including queued work, without waiting on inherited admission. */
  function getCompetingSessionWorkAdmissionRelease(
    params: SessionWorkAdmissionReleaseParams & { owner?: symbol; excludePendingOwner?: symbol },
  ): Promise<void> | undefined {
    const current = currentAdmissions();
    return sessionWorkAdmissionRelease(
      params,
      (admission) =>
        !current?.has(admission) &&
        (params.owner === undefined || admission.owner === params.owner) &&
        !(
          params.excludePendingOwner !== undefined &&
          admission.phase === "pending" &&
          admission.owner === params.excludePendingOwner
        ),
    );
  }

  /** Capture terminal owners without waiting on a live turn or a later successor. */
  function getTerminalSessionWorkAdmissionRelease(
    params: SessionWorkAdmissionReleaseParams,
  ): Promise<void> | false {
    const current = currentAdmissions();
    const admissions = collectSessionWorkAdmissions(
      normalizeSessionIdentities(params.scope, params.identities),
      (admission) => admission.phase === "acquired" && !current?.has(admission),
    );
    if ([...admissions].some((admission) => !admission.isSettling?.())) {
      return false;
    }
    return Promise.all([...admissions].map((admission) => admission.released)).then(
      () => undefined,
    );
  }

  return {
    collectSessionWorkAdmissions,
    collectActiveSessionWorkAdmissions,
    getActiveSessionWorkAdmissionCount,
    isSessionWorkAdmissionActive,
    getSessionWorkAdmissionRelease,
    getSessionWorkAdmissionOwnerRelease,
    getCompetingSessionWorkAdmissionRelease,
    getTerminalSessionWorkAdmissionRelease,
  };
}
