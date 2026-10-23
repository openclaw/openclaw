/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paintChatPullRequests,
  clearChatPullRequests,
  publication,
  sessionBranch,
} from "./chat-pull-requests.test-support.ts";
import type { ChatPullRequestsProps } from "./chat-pull-requests.tsx";

describe("failed publication account discovery", () => {
  let container: HTMLDivElement;

  function paint(props: Partial<ChatPullRequestsProps>) {
    paintChatPullRequests(
      {
        pullRequests: [],
        status: "ready",
        onDismiss: () => {},
        ...props,
      },
      container,
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    clearChatPullRequests(container);
    container.remove();
  });

  it("collapses into one refresh action on the branch row", () => {
    const onRefresh = vi.fn();
    paint({
      branch: sessionBranch(),
      publication: publication({
        selection: null,
        error: "GitHub publication options timed out after 5 seconds; retry the request.",
        optionsUnavailable: true,
        onRefresh,
      }),
    });
    const row = container.querySelector('.chat-pr[data-state="branch"]');
    expect(row?.querySelector(".chat-pr__publication-outcome")).toBeNull();
    expect(row?.querySelector(".chat-pr__create")).toBeNull();
    expect(row?.textContent).not.toContain("Publication status unavailable");
    expect(row?.querySelector("openclaw-tooltip")?.getAttribute("content")).toBe(
      "Publication status unavailable: GitHub publication options timed out after 5 seconds; retry the request.",
    );
    row?.querySelector<HTMLButtonElement>(".chat-pr__publication-refresh")?.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("is not retained once the branch row is dismissed", () => {
    paint({
      branch: sessionBranch(),
      branchDismissed: true,
      publication: publication({
        selection: null,
        error: "GitHub publication options timed out.",
        optionsUnavailable: true,
      }),
    });
    expect(container.querySelector(".chat-prs")).toBeNull();
  });
});
