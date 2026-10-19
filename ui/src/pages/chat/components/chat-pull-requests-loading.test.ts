/* @vitest-environment jsdom */

import { createComponent, createSignal, flush, merge, type Setter } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import * as staleRecovery from "../../../app/stale-chunk-reload.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { pullRequest } from "./chat-pull-requests.test-support.ts";
import { ChatPullRequests, type ChatPullRequestsProps } from "./chat-pull-requests.tsx";

describe("pull request renderer loading", () => {
  afterEach(() => {
    cleanupSolid();
    vi.doUnmock("./chat-pull-requests-content.tsx");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mount(initial: ChatPullRequestsProps) {
    let update!: Setter<ChatPullRequestsProps>;
    const view = mountSolid(() => {
      const [props, setProps] = createSignal(initial);
      update = setProps;
      return createComponent(ChatPullRequests, merge(props));
    });
    return { ...view, update };
  }

  it("keeps an empty chat cold and presents current PR data after the first load", async () => {
    const ready = createDeferred();
    onTestFinished(() => ready.resolve());
    let imports = 0;
    // mock-isolation: hold the module transport and render the actual PR implementation.
    vi.doMock("./chat-pull-requests-content.tsx", async () => {
      imports++;
      await ready.promise;
      return vi.importActual<typeof import("./chat-pull-requests-content.tsx")>(
        "./chat-pull-requests-content.tsx",
      );
    });
    const initial: ChatPullRequestsProps = {
      pullRequests: [],
      status: "ready",
      onDismiss: vi.fn(),
    };
    const view = mount(initial);
    expect(view.container.querySelector(".chat-prs")).toBeNull();
    expect(imports).toBe(0);
    view.update({ ...initial, pullRequests: [pullRequest()] });
    await waitForSolid(() => {
      expect(imports).toBe(1);
      expect(view.container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    });
    const onDismiss = vi.fn();
    const current = pullRequest({ number: 42, title: "Current work" });
    view.update({ ...initial, pullRequests: [current], onDismiss });
    ready.resolve();
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-pr__number")?.textContent).toBe(
        "openclaw/openclaw#42",
      ),
    );
    const row = view.container.querySelector(".chat-pr");
    const automation = row?.querySelector("openclaw-chat-ci-automation");
    view.update({ ...initial, pullRequests: [{ ...current, title: "Refreshed work" }], onDismiss });
    flush();
    expect(view.container.querySelector(".chat-pr")).toBe(row);
    expect(row?.querySelector("openclaw-chat-ci-automation")).toBe(automation);
    view.container.querySelector<HTMLButtonElement>(".chat-pr__dismiss")!.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(initial.onDismiss).not.toHaveBeenCalled();
    expect(imports).toBe(1);
  });

  it("keeps a failed PR renderer load visible and retries through the public component", async () => {
    // mock-isolation: fail the actual chunk boundary before any row mounts.
    vi.doMock("./chat-pull-requests-content.tsx", () => {
      throw new Error("PR renderer chunk could not be loaded");
    });
    const view = mount({ pullRequests: [pullRequest()], status: "ready", onDismiss: vi.fn() });
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "PR renderer chunk could not be loaded",
      ),
    );
    vi.doUnmock("./chat-pull-requests-content.tsx");
    view.getByRole("button", { name: "Retry" }).click();
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-pr__number")?.textContent).toBe(
        "openclaw/openclaw#103469",
      ),
    );
  });

  it.each(["current", "hidden", "session changed", "dismissed", "unmounted"] as const)(
    "reloads a stale PR view only for a current owner (%s)",
    async (state) => {
      // Mock the lazy export access so Vitest does not wrap the transport error in its factory error.
      vi.doMock("./chat-pull-requests-content.tsx", () => ({
        get ChatPullRequestsContent() {
          throw new TypeError("Failed to fetch dynamically imported module: /assets/pr.js");
        },
      }));
      const probe = createDeferred<Response>();
      onTestFinished(() => probe.resolve(new Response("", { status: 200 })));
      const fetchDocument = vi.fn<typeof fetch>(() => probe.promise);
      vi.stubGlobal("fetch", fetchDocument);
      const reload = vi.fn();
      const recover = staleRecovery.retryStaleChunkReloadWhenReachable;
      let pending: Promise<boolean> | undefined;
      vi.spyOn(staleRecovery, "retryStaleChunkReloadWhenReachable").mockImplementation(
        (options) => {
          pending = recover({
            ...options,
            storage: { getItem: () => null, setItem: () => {} },
            reload,
          });
          return pending;
        },
      );
      let presented = true;
      const initial: ChatPullRequestsProps = {
        pullRequests: [pullRequest()],
        sessionKey: "agent:main:first",
        sessionId: "first",
        status: "ready",
        onDismiss: vi.fn(),
        presented: { owner: new EventTarget(), isPresented: () => presented },
      };
      const view = mount(initial);
      await waitForSolid(() => {
        expect(view.getByRole("button", { name: "Reload" })).toBeTruthy();
      });
      view.getByRole("button", { name: "Reload" }).click();
      await waitForSolid(() => expect(fetchDocument).toHaveBeenCalledOnce());
      if (state === "hidden") {
        presented = false;
      } else if (state === "session changed") {
        view.update({ ...initial, sessionKey: "agent:main:second", sessionId: "second" });
      } else if (state === "dismissed") {
        view.update({ ...initial, dismissed: true });
      } else if (state === "unmounted") {
        view.unmount();
      }
      flush();
      probe.resolve(new Response("", { status: 200 }));
      expect(await pending).toBe(state === "current");
      expect(reload).toHaveBeenCalledTimes(state === "current" ? 1 : 0);
    },
  );
});
