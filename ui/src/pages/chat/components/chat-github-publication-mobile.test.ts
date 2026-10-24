/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  GitHubPublicationMobile,
  type GitHubPublicationMobileProps,
} from "./chat-github-publication-mobile.tsx";
import { publication, sessionBranch } from "./chat-pull-requests.test-support.ts";

describe("mobile publication review", () => {
  let view: ReturnType<typeof mountSolid>;

  function render(props: Omit<GitHubPublicationMobileProps, "presented">) {
    view = mountSolid(() =>
      createComponent(GitHubPublicationMobile, { ...props, presented: true }),
    );
    flush();
    return view.container;
  }

  afterEach(() => view?.unmount());

  it("opens a review without publishing and keeps an unknown base absent", () => {
    const onPublish = vi.fn();
    const onRefresh = vi.fn();
    const onDismissBranch = vi.fn();
    const branch = sessionBranch({ owner: "example", repo: "project", branch: "feature/review" });
    const container = render({
      publication: publication({ onPublish, onRefresh }),
      branch,
      onDismissBranch,
    });
    expect(container.textContent).toContain("example/project");
    expect(container.textContent).toContain("feature/review");
    expect(container.textContent).not.toContain("main");
    expect(container.textContent).not.toContain("Unpublished");
    expect(onPublish).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onDismissBranch).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>(".chat-pr-mobile__hide")!.click();
    expect(onDismissBranch).toHaveBeenCalledExactlyOnceWith(branch);
    expect(onPublish).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>(".chat-pr__create")!.click();
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("reviews the accepted personal snapshot rather than today's branch and diff", () => {
    const onConfirm = vi.fn();
    const onDismissBranch = vi.fn();
    const container = render({
      onDismissBranch,
      branch: sessionBranch({
        owner: "different",
        repo: "checkout",
        branch: "another-task",
        additions: 999,
      }),
      publication: publication({
        locked: true,
        onConfirm,
        result: {
          status: "needs_confirmation",
          requestId: "request-original",
          publisher: { source: "personal", accountId: 2, login: "alice-tools" },
          message: "Review the original publication.",
        },
        confirmation: {
          account: { accountId: 2, login: "alice-tools" },
          generation: "generation-original",
          requestDigest: "a".repeat(64),
          repository: "example/original",
          pushRepository: "alice-tools/original",
          branch: "feature/original",
          baseBranch: "release",
          sourceHeadCommit: "b".repeat(40),
          sourceIndexTree: "c".repeat(40),
          workspaceTree: "d".repeat(40),
        },
      }),
    });
    expect(container.textContent).toContain("example/original");
    expect(container.textContent).toContain("feature/original");
    expect(container.textContent).toContain("release");
    expect(container.textContent).toContain("alice-tools");
    expect(container.textContent).not.toContain("another-task");
    expect(container.textContent).not.toContain("999");
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-pr-mobile__hide")).toBeNull();
    expect(onDismissBranch).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>(".chat-pr__create")!.click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "without a branch", branch: undefined },
    { label: "with a current branch", branch: sessionBranch() },
  ])("keeps recovery available $label and no known result", ({ branch }) => {
    const onPublish = vi.fn();
    const onDismissBranch = vi.fn();
    const container = render({
      publication: publication({ locked: true, onPublish }),
      branch,
      onDismissBranch,
    });
    expect(container.querySelector(".chat-pr-mobile__hide")).toBeNull();
    expect(onDismissBranch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The outcome is unknown.");
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(onPublish).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(false);
  });

  it("checks an accepted receipt through the primary action without republishing", () => {
    const onRefresh = vi.fn();
    const onPublish = vi.fn();
    const onDismissBranch = vi.fn();
    const container = render({
      branch: sessionBranch(),
      onDismissBranch,
      publication: publication({
        locked: true,
        result: { status: "requested", requestId: "accepted-request", message: "Accepted." },
        onRefresh,
        onPublish,
      }),
    });
    const button = container.querySelector<HTMLButtonElement>(".chat-pr__create")!;
    expect(container.querySelector(".chat-pr-mobile__hide")).toBeNull();
    expect(onDismissBranch).not.toHaveBeenCalled();
    expect(button.textContent).toBe("Check publication");
    expect(button.disabled).toBe(false);
    button.click();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("offers recovery instead of account changes when the options are unavailable", () => {
    const onSelect = vi.fn();
    const onRefresh = vi.fn();
    const container = render({
      publication: publication({
        optionsUnavailable: true,
        onSelect,
        onRefresh,
        error: "Connection unavailable",
        options: {
          shared: { source: "system-configured", accountId: 1, login: "system-bot" },
          personal: {
            state: "connected",
            generation: "personal-generation",
            account: { accountId: 2, login: "alice-tools" },
            accessExpiresAtMs: null,
            refreshState: "available",
            pending: null,
          },
          pendingPersonal: null,
          latestShared: null,
        },
      }),
    });
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(container.textContent).toContain("Connection unavailable");
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector(".github-publication-mobile__actions")).toBeNull();
    container
      .querySelector<HTMLButtonElement>(
        '.github-publication-mobile__heading [aria-label="Refresh publication"]',
      )!
      .click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("links to the exact published receipt with native navigation", () => {
    const result = {
      status: "published" as const,
      requestId: "request-original",
      repository: "example/original",
      branch: "feature/original",
      headCommit: "b".repeat(40),
      url: "https://github.com/example/original/pull/317",
    };
    const onDismissBranch = vi.fn();
    const container = render({
      publication: publication({ result }),
      branch: sessionBranch(),
      onDismissBranch,
    });
    expect(container.querySelector(".chat-pr-mobile__hide")).toBeNull();
    expect(onDismissBranch).not.toHaveBeenCalled();
    const link = container.querySelector<HTMLAnchorElement>("a.chat-pr__create")!;
    expect(link.href).toBe(result.url);
    for (const modifier of [undefined, "metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      let handled: boolean | undefined;
      container.addEventListener(
        "click",
        (event) => {
          handled = event.defaultPrevented;
          // Observe the component's decision, then prevent JSDOM from following the URL.
          event.preventDefault();
        },
        { once: true },
      );
      link.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...(modifier ? { [modifier]: true } : {}),
        }),
      );
      expect(handled).toBe(false);
    }
  });
});
