import {
  matchesAgentWorkAdmission,
  type AgentWorkAdmissionIdentity,
} from "./session-agent-work-admission.js";
import {
  collectSessionIdentityTargets,
  normalizeSessionIdentities,
} from "./session-lifecycle-identity.js";
import type { HandoffSessionWorkAdmission } from "./session-work-admission-handoff.js";

export type SessionWorkRun = Readonly<{
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  controlUiVisible?: boolean;
}>;

type ReleasableSessionWorkAdmission = Pick<
  HandoffSessionWorkAdmission,
  "interrupt" | "interrupted"
> & {
  run?: SessionWorkRun;
  agent?: AgentWorkAdmissionIdentity;
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

  /** Capture exact run owners without interrupting unrelated or initiating admissions. */
  function captureSessionWorkRunInterruptions(params: {
    scope: string;
    identities: Iterable<string | undefined>;
    accept: (run: SessionWorkRun) => boolean;
  }): Array<{ run: SessionWorkRun; interrupt: (reason: Error) => boolean }> {
    const identities = normalizeSessionIdentities(params.scope, params.identities);
    const current = currentAdmissions();
    const isCurrent = (admission: T) =>
      !admission.interrupted &&
      identities.some((identity) => admissionsByIdentity.get(identity)?.has(admission));
    const admissions = collectSessionWorkAdmissions(
      identities,
      (admission) => !current?.has(admission) && isCurrent(admission),
    );
    return Array.from(admissions).flatMap((admission) => {
      const run = admission.run;
      if (!run || !params.accept(run)) {
        return [];
      }
      return [
        {
          run,
          interrupt: (reason: Error) => {
            // Awaited preparation cannot transfer Stop to a released or replaced owner.
            if (!isCurrent(admission)) {
              return false;
            }
            return admission.interrupt?.(reason)?.runId === run.runId;
          },
        },
      ];
    });
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

  /** Whether another admitted turn currently owns any of these session identities. */
  function isCompetingSessionWorkAdmissionActive(
    scope: string,
    identities: Iterable<string | undefined>,
    agent?: AgentWorkAdmissionIdentity,
  ): boolean {
    const current = currentAdmissions();
    return normalizeSessionIdentities(scope, identities).some((identity) =>
      [...(admissionsByIdentity.get(identity) ?? [])].some(
        (admission) =>
          admission.phase === "acquired" &&
          !current?.has(admission) &&
          (!agent || matchesAgentWorkAdmission(agent, admission.agent)),
      ),
    );
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
    captureSessionWorkRunInterruptions,
    collectActiveSessionWorkAdmissions,
    getActiveSessionWorkAdmissionCount,
    isSessionWorkAdmissionActive,
    isCompetingSessionWorkAdmissionActive,
    getSessionWorkAdmissionRelease,
    getSessionWorkAdmissionOwnerRelease,
    getCompetingSessionWorkAdmissionRelease,
    getTerminalSessionWorkAdmissionRelease,
  };
}
