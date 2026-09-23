// Stable Control UI contract barrel for Gateway callers. Browser code imports
// narrow browser-safe modules directly so lazy route owners stay out of startup.
export * from "./control-ui-bootstrap-contract.js";
export * from "./control-ui-plugin-frame-contract.js";
export * from "./control-ui-resource-routes.js";
export * from "./control-ui-root-assets.js";
export * from "./control-ui-user-avatar-route.js";

/** Targeted pushed PR snapshot event for subscribed Control UI connections. */
export const CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT =
  "controlUi.sessionPullRequests.changed";

/** Maximum session keys retained by one Control UI PR subscription. */
export const CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS = 200;

/** Anonymous public-page presentation; remote URLs never cross into the renderer. */
export type ControlUiLinkPreview = {
  title?: string;
  description?: string;
  imageDataUrl?: string;
  faviconDataUrl?: string;
};

/** Bounded session metadata rendered by Control UI session-link hover cards. */
export type ControlUiSessionPreview =
  | {
      status: "ok";
      sessionKey: string;
      title?: string;
      derivedTitle?: string;
      agentId: string;
      kind?: string;
      channel?: string;
      updatedAt?: number;
      lastMessagePreview?: string;
      archived?: boolean;
    }
  | { status: "unavailable" };

// Control UI ships inside the gateway dist, so these payloads move in
// lockstep with the server; shapes here are not independently versioned.
/** Check-run rollup for a PR head commit, chip pill + CI monitoring popover. */
type ControlUiSessionPullRequestChecks = {
  state: "pending" | "passing" | "failing";
  passed: number;
  failed: number;
  skipped: number;
  /** Queued/in-progress runs plus stale conclusions GitHub invalidated. */
  running: number;
};

/** Ordered GitHub Actions step facts; timestamps let the client render live duration. */
export type ControlUiSessionPullRequestCheckStep = {
  number: number;
  name: string;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ControlUiSessionPullRequestCheck = {
  id: number;
  name: string;
  state: "failed" | "running" | "passed" | "skipped";
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  source: "actions" | "check";
  /** Absent for non-Actions checks or when Actions details could not be loaded. */
  steps?: ControlUiSessionPullRequestCheckStep[];
};

/** On-demand details bound to one session PR head, never part of background polling. */
export type ControlUiSessionPullRequestCheckDetails = {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  checks: ControlUiSessionPullRequestCheck[];
  status: "ready" | "stale" | "unavailable";
  rateLimited: boolean;
  error?: string;
  retryAfterMs?: number;
};

/** A working-branch PR or a same-repository PR linked in recent assistant replies. */
export type ControlUiSessionPullRequest = {
  number: number;
  /**
   * Author login from the list payload GitHub already returns; no extra call.
   * Absent for a ghosted or deleted account. Deliberately login-only: the
   * sibling GitHub-link hovercard inlines avatars server-side rather than
   * hotlinking them, so a remote <img> here would leak a browser request to
   * GitHub on every hover.
   */
  author?: { login: string };
  owner: string;
  repo: string;
  branch: string;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Latest check-run rollup for the head commit; absent when no checks ran. */
  checks?: ControlUiSessionPullRequestChecks;
  checksUrl?: string;
  /** Head binding for on-demand CI details; not a client-selected repository revision. */
  headSha?: string;
};

/**
 * The session's working branch, resolved from local git only so the pre-PR
 * "Create PR" row keeps rendering while the GitHub quota is exhausted.
 */
export type ControlUiSessionBranch = {
  owner: string;
  repo: string;
  branch: string;
  /** Working-tree diff vs the merge base with the remote default branch. */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /**
   * GitHub "open a pull request for this branch" page. Absent while the
   * branch is unpushed or has nothing to compare — the row then only reports
   * the session's local changed files.
   */
  createUrl?: string;
};

/** Pull requests detected for a session's git branch, chip row payload. */
export type ControlUiSessionPullRequests = {
  pullRequests: ControlUiSessionPullRequest[];
  /**
   * Present whenever the session's checkout resolves to a GitHub remote,
   * independent of whether a PR or branch row exists.
   */
  repository?: { owner: string; repo: string };
  /**
   * Present when the session's non-default GitHub branch has a creatable PR
   * on origin or local changed files in the working tree.
   */
  branch?: ControlUiSessionBranch;
  /** GitHub quota exhausted; entries may be stale until the limit resets. */
  rateLimited: boolean;
  /** A failed PR lookup may still carry independently resolved repository facts. */
  status?: "ready" | "rate-limited" | "unavailable";
};

/** Per-session pushed state; unavailable snapshots preserve prior UI state. */
export type ControlUiSessionPullRequestSnapshot = ControlUiSessionPullRequests & {
  status: NonNullable<ControlUiSessionPullRequests["status"]>;
};

/** Targeted delta event for sessions watched by one Control UI connection. */
export type ControlUiSessionPullRequestsChanged = {
  sessions: Record<string, ControlUiSessionPullRequestSnapshot>;
};
