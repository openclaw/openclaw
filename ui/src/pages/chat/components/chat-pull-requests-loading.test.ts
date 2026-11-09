/* @vitest-environment jsdom */

import { createComponent, createSignal, flush, merge, type Setter } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import * as staleRecovery from "../../../app/stale-chunk-reload.ts";
import { createGatewayHarness } from "../../../lib/session-pull-requests.test-support.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { pullRequest } from "./chat-pull-requests.test-support.ts";
import { ChatPullRequests, type ChatPullRequestsProps } from "./chat-pull-requests.tsx";

describe("pull request renderer loading", () => {
  afterEach(() => {
    cleanupSolid();
    vi.doUnmock("./chat-pull-requests-content.tsx");
    vi.doUnmock("./chat-ci-details.tsx");
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

  it("loads CI on first open, stays idle if closed during loading, and retains the reopened owner", async () => {
    const ready = createDeferred();
    onTestFinished(() => ready.resolve());
    let imports = 0;
    // mock-isolation: hold only the panel transport; its real owner still admits every read.
    vi.doMock("./chat-ci-details.tsx", async () => {
      imports++;
      await ready.promise;
      return vi.importActual<typeof import("./chat-ci-details.tsx")>("./chat-ci-details.tsx");
    });
    const harness = createGatewayHarness();
    harness.request.mockResolvedValue({
      owner: "openclaw",
      repo: "openclaw",
      number: 103469,
      headSha: "a".repeat(40),
      status: "ready",
      rateLimited: false,
      checks: [],
    });
    const view = mount({
      pullRequests: [pullRequest({ headSha: "a".repeat(40) })],
      gateway: harness.gateway,
      sessionKey: "agent:main:ci-loading",
      status: "ready",
      onDismiss: vi.fn(),
    });
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-pr__checks")).not.toBeNull(),
    );
    const disclosure = view.container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    expect(imports).toBe(0);
    expect(view.container.querySelector("openclaw-chat-ci-details")).toBeNull();
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    await waitForSolid(() => expect(imports).toBe(1));
    disclosure.open = false;
    disclosure.dispatchEvent(new Event("toggle"));
    ready.resolve();
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-chat-ci-details")).not.toBeNull(),
    );
    expect(harness.request).not.toHaveBeenCalled();
    const owner = view.container.querySelector("openclaw-chat-ci-details");
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    await waitForSolid(() => expect(view.container.querySelector(".chat-ci__jobs")).not.toBeNull());
    await waitForSolid(() => expect(harness.request).toHaveBeenCalledOnce());
    disclosure.open = false;
    disclosure.dispatchEvent(new Event("toggle"));
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    flush();
    expect(view.container.querySelector("openclaw-chat-ci-details")).toBe(owner);
    expect(imports).toBe(1);
  });

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
      expect(view.getByRole("status", { name: "Loading…" }).getAttribute("aria-busy")).toBe("true");
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
    const disclosure = row?.querySelector<HTMLDetailsElement>(".chat-pr__checks");
    disclosure!.open = true;
    disclosure!.dispatchEvent(new Event("toggle"));
    await waitForSolid(() =>
      expect(row?.querySelector("openclaw-chat-ci-automation")).not.toBeNull(),
    );
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
      // mock-isolation: fail lazy export access without Vitest wrapping the transport error.
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
