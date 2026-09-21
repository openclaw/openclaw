/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../../api/gateway.ts";
import {
  composerFixture,
  people,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { HumanMentionMenu } from "./components/chat-composer-mention-menu.ts";

afterEach(resetMentionComposerFixture);

const freshMs = 5 * 60_000;

describe.each(["chat", "new-session"] as const)("%s mention query cache", (kind) => {
  it.each(["dismiss", "select", "new token"])(
    "reuses results immediately after %s",
    async (action) => {
      const view = composerFixture(kind);
      view.edit("@Al");
      await vi.advanceTimersByTimeAsync(150);
      if (action === "select") {
        view.key("Enter");
      } else if (action === "dismiss") {
        view.key("Escape");
      }
      view.edit("Review @Al");
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(view.container.querySelector(".mention-menu__loading")).toBeNull();
      await vi.advanceTimersByTimeAsync(150);
      expect(view.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["before", "after"])(
    "keeps an in-flight result when reopened %s it settles",
    async (reopen) => {
      const view = composerFixture(kind);
      const response = createDeferred<UsersMentionableResult>();
      view.request.mockReturnValueOnce(response.promise);
      view.edit("@Al");
      await vi.advanceTimersByTimeAsync(150);
      view.key("Escape");
      if (reopen === "before") {
        view.edit("Review @Al");
        await vi.advanceTimersByTimeAsync(150);
      }
      response.resolve(people);
      await vi.advanceTimersByTimeAsync(0);
      if (reopen === "after") {
        expect(view.container.querySelector('[role="listbox"]')).toBeNull();
        view.edit("Review @Al");
      }
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(view.request).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes stale results in the background without losing keyboard selection", async () => {
    const view = composerFixture(kind);
    view.edit("@Al");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(freshMs);
    const response = createDeferred<UsersMentionableResult>();
    view.request.mockReturnValueOnce(response.promise);
    view.edit("Review @Al");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(view.container.querySelector(".mention-menu__loading")).toBeNull();
    view.key("ArrowDown");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
    response.resolve({ users: people.users.toReversed(), truncated: false });
    await vi.advanceTimersByTimeAsync(0);
    view.key("Enter");
    expect(view.value().mentions).toEqual([
      { profileId: "profile-alex-offline", start: 7, end: 12 },
    ]);
    expect(view.send).not.toHaveBeenCalled();
  });

  it.each(["outage", "revoked"])("handles a background refresh failure: %s", async (failure) => {
    const view = composerFixture(kind);
    view.edit("@Al");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(freshMs);
    view.request.mockRejectedValueOnce(
      failure === "outage"
        ? new Error("Connection interrupted")
        : new GatewayRequestError({ code: "FORBIDDEN", message: "Access revoked" }),
    );
    view.edit("Review @Al");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(
      failure === "outage" ? 2 : 0,
    );
    if (failure === "outage") {
      view.key("Enter");
      expect(view.value().mentions).toHaveLength(1);
    } else {
      expect(view.container.textContent).toContain("Retry");
      view.key("Escape");
      view.edit("Again @Al");
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(view.request).toHaveBeenCalledTimes(3);
    }
  });

  it.each(["switch query", "close", "replace owner"])(
    "does not publish an old refresh after %s",
    async (action) => {
      const view = composerFixture(kind);
      view.edit("@Al");
      await vi.advanceTimersByTimeAsync(150);
      view.key("Escape");
      await vi.advanceTimersByTimeAsync(freshMs);
      const response = createDeferred<UsersMentionableResult>();
      view.request.mockReturnValueOnce(response.promise);
      view.edit("Review @Al");
      await vi.advanceTimersByTimeAsync(150);
      if (action === "switch query") {
        view.request.mockResolvedValueOnce({ users: [], truncated: false });
        view.edit("Review @Nobody");
        await vi.advanceTimersByTimeAsync(150);
      } else if (action === "close") {
        view.key("Escape");
      } else {
        view.replaceOwner();
      }
      response.resolve(people);
      await vi.advanceTimersByTimeAsync(0);
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
      if (action === "replace owner") {
        view.edit("Again @Al");
        expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(150);
        expect(view.request).toHaveBeenCalledTimes(3);
      }
    },
  );
  it("backs off failed refreshes without extending the snapshot's maximum age", async () => {
    const view = composerFixture(kind);
    view.edit("@Al");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(freshMs);
    view.request.mockRejectedValue(new Error("Connection interrupted"));
    view.edit("Review @Al");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Escape");
    view.edit("Again @Al");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(30_000);
    view.edit("Retry @Al");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(3);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    view.edit("Expired @Al");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.container.textContent).toContain("Retry");
  });

  it("keeps only sixteen successful exact-query snapshots across picker openings", async () => {
    const view = composerFixture(kind);
    for (let index = 0; index < 17; index += 1) {
      view.edit(`@Person ${index}`);
      await vi.advanceTimersByTimeAsync(150);
      view.key("Escape");
    }
    view.edit("@Person 16");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    view.key("Escape");
    view.edit("@Person 0");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(18);
  });

  it("fences other pending successes when identity verification is lost", async () => {
    const view = composerFixture(kind);
    const old = createDeferred<UsersMentionableResult>();
    view.request.mockReturnValueOnce(old.promise).mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Profile unavailable",
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      }),
    );
    view.edit("@Al");
    await vi.advanceTimersByTimeAsync(150);
    view.edit("@Other");
    await vi.advanceTimersByTimeAsync(150);
    old.resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    view.edit("@Al");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(3);
  });
  it("releases a stalled lookup at its deadline and accepts a fresh retry", async () => {
    const view = composerFixture(kind);
    const protocol = new GatewayPendingRequests({
      createRequestId: () => "mentions",
      nowMs: Date.now,
    });
    const sent: Array<{ id: string }> = [];
    view.request.mockImplementation((method, params, options) =>
      protocol.request({ send: (frame) => sent.push(JSON.parse(frame)) }, method, params, options),
    );
    view.edit("@Al");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Escape");
    view.edit("Review @Al");
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view.container.textContent).toContain("Retry");
    view.key("Escape");
    view.edit("Again @Al");
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toHaveLength(2);
    protocol.handleResponse({
      type: "res",
      id: sent[0]!.id,
      ok: true,
      payload: { users: [], truncated: false },
    });
    protocol.handleResponse({ type: "res", id: sent[1]!.id, ok: true, payload: people });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    view.key("Enter");
    expect(view.value().mentions).toHaveLength(1);
  });
});

it.each(["pending", "denied"])(
  "fences reused directory descriptors while a replacement is %s",
  async (replacement) => {
    vi.useFakeTimers();
    const menu = new HumanMentionMenu();
    onTestFinished(() => menu.dispose());
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    const original = createDeferred<UsersMentionableResult>();
    const current = createDeferred<UsersMentionableResult>();
    const fresh: UsersMentionableResult = {
      users: [{ profileId: "fresh", displayName: "Fresh", online: true }],
      truncated: false,
    };
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue(fresh)
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(current.promise);
    const directory = { client, ownerKey: "A", params: { sessionKey: "agent:main:chat" } };
    const other = { ...directory, ownerKey: "B" };
    const render = vi.fn();
    const input = { value: "@Al", selectionStart: 3, selectionEnd: 3 };
    menu.syncDirectory(directory);
    menu.update(input, render, "trigger");
    await vi.advanceTimersByTimeAsync(150);
    menu.syncDirectory(other);
    menu.syncDirectory(directory);
    menu.update(input, render, "trigger");
    await vi.advanceTimersByTimeAsync(150);
    if (replacement === "denied") {
      current.reject(new GatewayRequestError({ code: "FORBIDDEN", message: "Access revoked" }));
      await vi.advanceTimersByTimeAsync(0);
      menu.syncDirectory(other);
      menu.syncDirectory(directory);
    }
    original.resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    menu.close();
    menu.update(input, render, "trigger");
    expect(menu.activeLabel()).toBe("");
    await vi.advanceTimersByTimeAsync(150);
    expect(request).toHaveBeenCalledTimes(replacement === "pending" ? 2 : 3);
    current.resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.activeLabel()).toBe("Fresh");
  },
);
