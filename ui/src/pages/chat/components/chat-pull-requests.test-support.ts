import { createComponent, createSignal, flush, merge } from "solid-js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { ChatPullRequestsContent } from "./chat-pull-requests-content.tsx";

export function pullRequest(
  overrides: Partial<ControlUiSessionPullRequest> = {},
): ControlUiSessionPullRequest {
  return {
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
    ...overrides,
  };
}

export function publication(overrides: Partial<GitHubPublicationView> = {}): GitHubPublicationView {
  return {
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
    ...overrides,
  };
}

export function sessionBranch(
  overrides: Partial<ControlUiSessionBranch> = {},
): ControlUiSessionBranch {
  return {
    owner: "openclaw",
    repo: "openclaw",
    branch: "claude/cloud-workers-live-events",
    additions: 2819,
    deletions: 205,
    createUrl: "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
    ...overrides,
  };
}

const views = new WeakMap<
  HTMLElement,
  { update: (props: ChatPullRequestsProps) => void; unmount: () => void }
>();

export function paintChatPullRequests(props: ChatPullRequestsProps, container: HTMLElement) {
  const view = views.get(container);
  if (view) {
    view.update(props);
  } else {
    let update!: (props: ChatPullRequestsProps) => void;
    const mounted = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        update = setCurrent;
        return createComponent(ChatPullRequestsContent, merge(current));
      },
      { container },
    );
    views.set(container, { update, unmount: mounted.unmount });
  }
  flush();
}

export function clearChatPullRequests(container: HTMLElement) {
  views.get(container)?.unmount();
  views.delete(container);
}
