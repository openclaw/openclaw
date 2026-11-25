import type { SessionPerson } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/schema/sessions-list.js";
import type { SessionObserverHealth } from "../../../packages/gateway-protocol/src/schema/sessions.js";

/** Bounded, current session facts for trusted background plugin classifiers. */
export type RuntimeSessionFacts = {
  key: string;
  sessionId: string;
  lifecycleRevision?: string;
  agentId: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  run: "active" | "idle" | "failed";
  observerDigest?: {
    health: SessionObserverHealth;
    headline: string;
    assessment?: string;
    revision: number;
  };
  pullRequests: Array<{
    number: number;
    state: "open" | "draft" | "merged" | "closed";
    url?: string;
    title?: string;
  }>;
  /** Unknown or stale PR state must not be interpreted as a confirmed empty list. */
  pullRequestsUnavailable?: boolean;
  pullRequestsRateLimited?: true;
  archived: boolean;
  lastActivityAt: number;
};

export type RuntimeSessionFactsResult = {
  sessions: RuntimeSessionFacts[];
  warnings?: string[];
};

export type RuntimeSessionFactsSelection = Pick<
  SessionsListParams,
  | "configuredAgentsOnly"
  | "includeGlobal"
  | "includeUnknown"
  | "excludeDock"
  | "excludeCron"
  | "excludeSystem"
  | "archived"
  | "sortBy"
  | "activeMinutes"
  | "agentId"
  | "involvingMe"
  | "involvingProfileId"
  | "includePeople"
>;

export type RuntimeSessionFactsSelectionResult = {
  /** Stable viewer and query identity; only reusable inside the current callback. */
  scope: string | undefined;
  /** Changes when the selected immutable facts, people, or activity deadline change. */
  revision: string;
  sessions: Array<
    RuntimeSessionFacts & {
      isMain?: boolean;
      unavailable?: string;
      pullRequestsStale?: true;
    }
  >;
  people?: SessionPerson[];
  activityExpiresAt?: number;
  retryAt?: number;
  /** Selected identities omitted by the current facts owner, distinct from failed reads. */
  missingSessionKeys?: readonly string[];
};
