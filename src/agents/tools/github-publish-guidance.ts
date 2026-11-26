import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { jsonResult, textResult } from "./common.js";

/** The github_publish definition: a short summary and one line per offered action. */
export function describeGitHubPublishTool(options: {
  publicationAvailable: boolean;
  prepareAvailable: boolean;
  refreshBaseAvailable: boolean;
  evidenceAvailable: boolean;
  workspacePreparationAvailable: boolean;
}): string {
  // One line per action; each result's `next` carries the procedure that applies at that point.
  const lines = [
    "GitHub issues and PRs via Gateway credentials. Each call checks identity, eligibility and write access. Follow next.",
    "- readiness: observe publication state and an existing requestId; never resubmit it.",
    "- inspect_pr: read a PR by pullRequestUrl.",
    "- create_issue: title and optional body.",
    "- create_comment: post approved Markdown (issueNumber, body).",
  ];
  if (options.publicationAvailable) {
    lines.push(
      `- publish (default): open a PR from accepted workspace changes (draft: true for a draft)${options.workspacePreparationAvailable ? "; for a committed local checkout pass workspacePath" : ""}.`,
      "- edit: omit title/body to read; send its headCommit as expectedHeadCommit with a change.",
      "- ready, request_review: mark a draft ready; post the fixed re-review request when asked.",
    );
    if (options.prepareAvailable) {
      lines.push("- prepare_pr: continue an existing PR by pullRequestUrl.");
    }
    if (options.refreshBaseAvailable) {
      lines.push("- refresh_base: integrate the current base (conflictsResolved, baseCommit).");
    }
    if (options.evidenceAvailable) {
      lines.push("- upload_evidence: attach an inspected workspace image or video.");
    }
  } else {
    lines.push(
      "This conversation cannot publish its own workspace; it can act on a selected publishing child's PR.",
    );
  }
  lines.push(
    "- inspect, merge, close: full operator write access; merge only on an explicit landing request after review and required checks.",
  );
  return lines.join("\n");
}

// Guidance the model needs once it holds a result, instead of on every request.
export const githubActionGuidance = {
  readiness:
    "Pending or unconfirmed work keeps its original requestId: observe it with readiness and that requestId; never resubmit it.",
  inspect_pr: "This read binds nothing and grants no later authority.",
  inspectPrPrepare: "To continue this PR, use prepare_pr with the same pullRequestUrl.",
  create_issue: "If creation is unconfirmed, check the repository before retrying.",
  create_comment: "If the post is unconfirmed, check the thread before retrying.",
  prepare_pr:
    "Tests and Auto Review use the returned review base. If headChanged is true, repeat to integrate the newer head. Resolve any conflictPaths, then repeat with conflictsResolved: true and expectedHeadCommit set to the returned headCommit. Then omit action to append accepted changes to the original PR; a remote head change refuses publication, so integrate it and never create a replacement PR. For edit, ready or request_review on the bound PR, read with edit first and send expectedHeadCommit without requestId.",
  refresh_base:
    "Resolve returned conflicts, then repeat with conflictsResolved: true and the returned baseCommit. Tests and Auto Review use the returned review base (mode local). Refresh never publishes or imports a newer PR head; use prepare_pr for that.",
  editRead:
    "To change title or body, send this headCommit as expectedHeadCommit, any publication requestId, the new value, and the value you read as expectedTitle/expectedBody. Keep attribution, marker and footer unchanged in the full body; omitted fields stay unchanged. Edit never pushes files or changes PR state.",
  edit: "After an uncertain response, read again with edit (same pullRequestUrl when explicit) before retrying.",
  ready: "This does not merge. After an uncertain response, read with edit before retrying.",
  request_review:
    'Only "@clawsweeper re-review" was posted; that is not review acceptance or completion. If the response was uncertain, read existing PR comments before any new request; never retry blindly.',
  upload_evidence:
    "Associate the uploaded URL in the PR body with edit, then verify reviewer access; uploaded does not prove public access. Never repeat an unconfirmed upload blindly.",
  inspect:
    "Land only on an explicit request from a person with full operator write access, after review and required checks pass: ready, then merge with this expectedHeadCommit, any publication requestId and mergeMethod. Actions never enable auto-merge. Inspect again after an uncertain response before retrying.",
  merge: "Inspect again after an uncertain response before retrying.",
  close:
    "Closing keeps saved work and does not merge. Inspect again after an uncertain response before retrying.",
  publish:
    'requested or publishing means accepted, not finished: retain requestId, finish the turn and await its result here; do not submit another publication to recover it. The receipt does not resume you. If authorized review, CI or landing remains, continue before ending the turn, or schedule a continuation with automations when it offers add (at + agentTurn + sessionTarget "session:<this session key from Runtime>"; rearm a waiting one with next_check, not a new job); otherwise explain the remaining work. Publishing this checkout again updates the same PR.',
} as const;

/** The model reads the guidance in the result text; details keep the Gateway's payload. */
export function guidedResult<T>(next: string | undefined, payload: T) {
  return next && isRecord(payload) && payload.next === undefined
    ? textResult(JSON.stringify({ ...payload, next }), payload)
    : jsonResult(payload);
}
