/* @vitest-environment jsdom */
import { Show, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import * as toast from "../../../lib/toast.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { PullRequestActions } from "./chat-pull-request-actions.tsx";
import { ChatPullRequestMobileDetail } from "./chat-pull-request-mobile.tsx";
import { pullRequest } from "./chat-pull-requests.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["desktop", "mobile"] as const)(
  "%s copy retains its control through failure and retry, then retires on URL replacement and unmount",
  async (mode) => {
    const first = createDeferredCore();
    const second = createDeferredCore();
    const third = createDeferredCore();
    const fourth = createDeferredCore();
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockReturnValueOnce(fourth.promise);
    vi.stubGlobal(
      "navigator",
      new Proxy(navigator, {
        get: (target, key) => (key === "clipboard" ? { writeText } : Reflect.get(target, key)),
      }),
    );
    const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const [pr, setPr] = createSignal(pullRequest({ url: "https://example.test/first" }));
    const [visible, setVisible] = createSignal(true);
    const view = mountSolid(() => (
      <Show when={visible()}>
        {mode === "desktop" ? (
          <PullRequestActions
            label="Pull request actions"
            disabled={false}
            presented
            onDismiss={() => {}}
            url={pr().url}
            pullRequest={pr()}
            owner={{ pullRequests: [pr()], status: "ready", onDismiss: () => {} }}
          />
        ) : (
          <ChatPullRequestMobileDetail
            pullRequest={pr()}
            hasSnapshot
            retrying={false}
            status="ready"
            onRetry={() => {}}
            onDismiss={() => {}}
          />
        )}
      </Show>
    ));
    if (mode === "desktop") {
      view.getByRole("button", { name: "Pull request actions" }).click();
      await waitForSolid(() =>
        expect(view.queryByRole("menuitem", { name: "Copy PR link" })).not.toBeNull(),
      );
    }
    const copy = () =>
      view.getByRole(mode === "desktop" ? "menuitem" : "button", { name: "Copy PR link" });
    const control = copy();
    control.click();
    control.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenNthCalledWith(1, "https://example.test/first");
    await waitForSolid(() =>
      expect(
        copy().getAttribute("aria-disabled") === "true" || copy().hasAttribute("disabled"),
        "first copy remains disabled while pending",
      ).toBe(true),
    );
    first.reject(new Error("Clipboard permission denied"));
    await waitForSolid(() => {
      expect(view.getByRole("alert").textContent).toBe("Couldn’t copy the PR link. Try again.");
      expect(copy()).toBe(control);
      expect(copy().getAttribute("aria-disabled")).not.toBe("true");
      expect(copy().hasAttribute("disabled")).toBe(false);
    });
    expect(notice).not.toHaveBeenCalled();
    setPr(pullRequest({ url: "https://example.test/replacement" }));
    flush();
    await waitForSolid(() => expect(view.queryByRole("alert")).toBeNull());
    setPr(pullRequest({ url: "https://example.test/first" }));
    flush();
    copy().click();
    expect(writeText).toHaveBeenNthCalledWith(2, "https://example.test/first");
    await waitForSolid(() => {
      expect(view.queryByRole("alert")).toBeNull();
      expect(copy()).toBe(control);
      expect(
        copy().getAttribute("aria-disabled") === "true" || copy().hasAttribute("disabled"),
        "retry remains disabled while pending",
      ).toBe(true);
    });
    expect(notice).not.toHaveBeenCalled();
    second.resolve();
    await waitForSolid(() => expect(notice).toHaveBeenCalledTimes(1));
    if (mode === "desktop") {
      view.getByRole("button", { name: "Pull request actions" }).click();
      await waitForSolid(() => expect(copy()).not.toBeNull());
    }
    copy().click();
    expect(writeText).toHaveBeenNthCalledWith(3, "https://example.test/first");
    await waitForSolid(() =>
      expect(
        copy().getAttribute("aria-disabled") === "true" || copy().hasAttribute("disabled"),
        "copy after success remains disabled while pending",
      ).toBe(true),
    );
    setPr(pullRequest({ url: "https://example.test/second" }));
    flush();
    await waitForSolid(() => {
      expect(copy().getAttribute("aria-disabled")).not.toBe("true");
      expect(copy().hasAttribute("disabled")).toBe(false);
    });
    copy().click();
    expect(writeText).toHaveBeenNthCalledWith(4, "https://example.test/second");
    await waitForSolid(() =>
      expect(
        copy().getAttribute("aria-disabled") === "true" || copy().hasAttribute("disabled"),
        "replacement URL copy remains disabled while pending",
      ).toBe(true),
    );
    setVisible(false);
    flush();
    await waitForSolid(() => expect(view.container.textContent).toBe(""));
    third.reject(new Error("Retired copy"));
    fourth.reject(new Error("Unmounted copy"));
    await Promise.allSettled([third.promise, fourth.promise]);
    await Promise.resolve();
    flush();
    expect(notice).toHaveBeenCalledTimes(1);
  },
);
