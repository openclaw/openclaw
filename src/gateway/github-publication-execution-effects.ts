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

type GitHubPublicationEffectTransition =
  | { operation: "updateHead"; headCommit: string }
  | { operation: "complete"; result: SessionGitHubPublicationResult }
  | {
      operation: "recordEffect";
      effect: "push" | "pull_request";
      observed?: { headCommit?: string; url?: string };
    }
  | { operation: "interrupt" };

/** Effect observations retain custody but never restore permission for another action. */
function githubPublicationEffectFacts(
  transition: GitHubPublicationEffectTransition,
  interruptedStatus: "requested" | "needs_confirmation",
): { values: GitHubPublicationMutableFacts; requireAction: boolean } {
  switch (transition.operation) {
    case "updateHead":
      return { values: { head_commit: transition.headCommit }, requireAction: true };
    case "complete": {
      const { result } = transition;
      if (result.status === "published") {
        return {
          values: {
            status: "published",
            head_commit: result.headCommit,
            pull_request_url: result.url,
            error_code: null,
            next_action: null,
          },
          requireAction: false,
        };
      }
      if (result.status !== "failed") {
        throw new Error("GitHub publication result is not terminal.");
      }
      return {
        values: { status: "failed", error_code: result.code, next_action: result.nextAction },
        requireAction:
          result.code !== "session_changed" &&
          (result.code !== "identity_changed" || interruptedStatus === "needs_confirmation"),
      };
    }
    case "recordEffect": {
      const { effect, observed } = transition;
      return {
        values: {
          last_effect: effect,
          effect_state: observed?.headCommit || observed?.url ? "observed" : "dispatched",
          ...(observed?.headCommit ? { head_commit: observed.headCommit } : {}),
          ...(observed?.url ? { pull_request_url: observed.url } : {}),
        },
        requireAction: !observed,
      };
    }
    case "interrupt":
      return {
        values: { status: interruptedStatus, error_code: null, next_action: null },
        requireAction: false,
      };
  }
  throw new Error("Unknown GitHub publication effect transition.");
}

/** Released synchronous adapters and worker transitions share the same effect reducer. */
export function createGitHubPublicationExecutionEffects<Row>(params: {
  write: (facts: GitHubPublicationMutableFacts, requireAction: boolean) => Row;
  interruptedStatus: "requested" | "needs_confirmation";
}) {
  const apply = (transition: GitHubPublicationEffectTransition) => {
    const { values, requireAction } = githubPublicationEffectFacts(
      transition,
      params.interruptedStatus,
    );
    return params.write(values, requireAction);
  };
  return {
    updateHead: (headCommit: string): Row => apply({ operation: "updateHead", headCommit }),
    complete: (result: SessionGitHubPublicationResult): Row =>
      apply({ operation: "complete", result }),
    recordEffect(
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ): void {
      apply({ operation: "recordEffect", effect, observed });
    },
    interrupt: (): Row => apply({ operation: "interrupt" }),
  };
}
