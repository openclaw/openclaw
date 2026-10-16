import { createComponent, createSignal, flush, merge } from "solid-js";
import type { ControlUiSessionBranch } from "../../../../../src/gateway/control-ui-contract.js";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-controller.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatPullRequests, type ChatPullRequestsProps } from "./chat-pull-requests.tsx";

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
        return createComponent(ChatPullRequests, merge(current));
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
