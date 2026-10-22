import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";

type GitHubPublicationMutableFacts = {
  status?: string;
  head_commit?: string | null;
  pull_request_url?: string | null;
  error_code?: string | null;
  next_action?: string | null;
  last_effect?: string | null;
  effect_state?: string | null;
};

export type GitHubPublicationEffectTransition =
  | { operation: "updateHead"; headCommit: string }
  | { operation: "complete"; result: SessionGitHubPublicationResult }
  | {
      operation: "recordEffect";
      effect: "push" | "pull_request";
      observed?: { headCommit?: string; url?: string };
    }
  | { operation: "interrupt" };

/** Effect observations retain custody but never restore permission for another action. */
export function githubPublicationEffectFacts(
  transition: GitHubPublicationEffectTransition,
  interruptedStatus: "requested" | "needs_confirmation",
): GitHubPublicationMutableFacts {
  switch (transition.operation) {
    case "updateHead":
      return { head_commit: transition.headCommit };
    case "complete": {
      const { result } = transition;
      if (result.status === "published") {
        return {
          status: "published",
          head_commit: result.headCommit,
          pull_request_url: result.url,
          error_code: null,
          next_action: null,
        };
      }
      if (result.status !== "failed") {
        throw new Error("GitHub publication result is not terminal.");
      }
      return {
        status: "failed",
        error_code: result.code,
        next_action: result.nextAction,
      };
    }
    case "recordEffect": {
      const { effect, observed } = transition;
      return {
        last_effect: effect,
        effect_state: observed?.headCommit || observed?.url ? "observed" : "dispatched",
        ...(observed?.headCommit ? { head_commit: observed.headCommit } : {}),
        ...(observed?.url ? { pull_request_url: observed.url } : {}),
      };
    }
    case "interrupt":
      return {
        status: interruptedStatus,
        error_code: null,
        next_action: null,
      };
  }
  throw new Error("Unknown GitHub publication effect transition.");
}
