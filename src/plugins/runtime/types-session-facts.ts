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
  pullRequests: Array<{ number: number; state: "open" | "draft" | "merged" | "closed" }>;
  /** Unknown or stale PR state must not be interpreted as a confirmed empty list. */
  pullRequestsUnavailable?: boolean;
  archived: boolean;
  lastActivityAt: number;
};

export type RuntimeSessionFactsResult = {
  sessions: RuntimeSessionFacts[];
  warnings?: string[];
};
