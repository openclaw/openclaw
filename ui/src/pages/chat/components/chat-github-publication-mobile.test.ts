/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  interrupted,
  options as publicationOptions,
} from "../chat-github-publication.test-support.ts";
import {
  GitHubPublicationMobile,
  type GitHubPublicationMobileProps,
} from "./chat-github-publication-mobile.tsx";
import { publication, sessionBranch } from "./chat-pull-requests.test-support.ts";

describe("mobile publication review", () => {
  let view: ReturnType<typeof mountSolid>;
  const query = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const action = () => view.container.querySelector<HTMLButtonElement>(".chat-pr__create")!;
  const onDismissBranch = vi.fn();
  function text(included: string[], excluded: string[] = []) {
    for (const value of included) {
      expect(view.container.textContent).toContain(value);
    }
    for (const value of excluded) {
      expect(view.container.textContent).not.toContain(value);
    }
  }
  function locked() {
    expect(query(".chat-pr-mobile__hide")).toBeNull();
    expect(onDismissBranch).not.toHaveBeenCalled();
  }

  function render(props: Omit<GitHubPublicationMobileProps, "presented">) {
    onDismissBranch.mockClear();
    view = mountSolid(() =>
      createComponent(GitHubPublicationMobile, { onDismissBranch, ...props, presented: true }),
    );
    flush();
    return view.container;
  }

  afterEach(() => view?.unmount());

  it("opens a review without publishing and keeps an unknown base absent", () => {
    const onPublish = vi.fn();
    const onRefresh = vi.fn();
    const branch = sessionBranch({ owner: "example", repo: "project", branch: "feature/review" });
    render({
      publication: publication({ onPublish, onRefresh }),
      branch,
    });
    text(["example/project", "feature/review"], ["main", "Unpublished"]);
    expect(onPublish).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onDismissBranch).not.toHaveBeenCalled();
    query(".chat-pr-mobile__hide")!.click();
    expect(onDismissBranch).toHaveBeenCalledExactlyOnceWith(branch);
    expect(onPublish).not.toHaveBeenCalled();
    action().click();
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("reviews the accepted personal snapshot rather than today's branch and diff", () => {
    const onConfirm = vi.fn();
    render({
      branch: sessionBranch({
        owner: "different",
        repo: "checkout",
        branch: "another-task",
        additions: 999,
      }),
      publication: publication({
        locked: true,
        onConfirm,
        ...interrupted,
      }),
    });
    text(["team/demo", "feature/one", "main", "alice-tools"], ["another-task", "999"]);
    expect(query('[aria-haspopup="menu"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    locked();
    action().click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("keeps recovery available without exposing the current branch for an unknown result", () => {
    const onPublish = vi.fn();
    render({
      publication: publication({ locked: true, onPublish }),
      branch: sessionBranch(),
    });
    locked();
    text(["The outcome is unknown."]);
    expect(query('[aria-haspopup="menu"]')).toBeNull();
    expect(onPublish).not.toHaveBeenCalled();
    expect(action().disabled).toBe(false);
  });

  it("offers recovery instead of account changes when the options are unavailable", () => {
    const onSelect = vi.fn();
    const onRefresh = vi.fn();
    render({
      publication: publication({
        optionsUnavailable: true,
        onSelect,
        onRefresh,
        error: "Connection unavailable",
        options: publicationOptions,
      }),
    });
    expect(query('[aria-haspopup="menu"]')).toBeNull();
    text(["Connection unavailable"]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(query(".github-publication-mobile__actions")).toBeNull();
    query('.github-publication-mobile__heading [aria-label="Refresh publication"]')!.click();
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
    const container = render({
      publication: publication({ result }),
      branch: sessionBranch(),
    });
    locked();
    const link = view.container.querySelector<HTMLAnchorElement>("a.chat-pr__create")!;
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
