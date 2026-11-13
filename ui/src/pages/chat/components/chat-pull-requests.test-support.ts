import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { ChatPullRequestsContent } from "./chat-pull-requests-content.tsx";

function fixture<T>(create: () => T) {
  return (overrides: Partial<T> = {}): T => ({ ...create(), ...overrides });
}

export const pullRequest = fixture<ControlUiSessionPullRequest>(() => ({
  number: 103469,
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
  title: "fix(macos): tighten the link-browser tab header",
  url: "https://github.com/openclaw/openclaw/pull/103469",
  state: "open",
  additions: 4,
  deletions: 3,
  checks: { state: "passing", passed: 5, failed: 0, skipped: 1, running: 0 },
  checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
}));

export const publication = fixture<GitHubPublicationView>(() => ({
  readiness: { read: null, retired: new Promise(() => {}) },
  activity: null,
  canPublishShared: true,
  canPublishPersonal: true,
  locked: false,
  options: null,
  selection: {
    source: "shared",
    expected: { source: "system-configured", accountId: 1, login: "system-bot" },
  },
  result: null,
  confirmation: null,
  error: null,
  optionsUnavailable: false,
  personalReady: true,
  onPublish: () => {},
  onRefresh: () => {},
}));

export const sessionBranch = fixture<ControlUiSessionBranch>(() => ({
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/cloud-workers-live-events",
  additions: 2819,
  deletions: 205,
  createUrl: "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
}));

const views = new WeakMap<HTMLElement, ReturnType<typeof mountSolid<ChatPullRequestsProps>>>();

export function paintChatPullRequests(
  overrides: Partial<ChatPullRequestsProps>,
  container: HTMLElement,
) {
  const props: ChatPullRequestsProps = {
    pullRequests: [],
    status: "ready",
    onDismiss: () => {},
    ...overrides,
  };
  const view = views.get(container);
  if (view) {
    view.update(props);
  } else {
    views.set(container, mountSolid(ChatPullRequestsContent, props, container));
  }
}

export function clearChatPullRequests(container: HTMLElement) {
  views.get(container)?.dispose();
  views.delete(container);
}
