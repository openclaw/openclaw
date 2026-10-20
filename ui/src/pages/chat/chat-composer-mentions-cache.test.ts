/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../../api/gateway.ts";
import {
  composerFixture,
  mention,
  people,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { createHumanMentionMenu } from "./components/chat-composer-mention-menu.tsx";

afterEach(resetMentionComposerFixture);

const fixture = () => composerFixture("chat");

async function staleFixture() {
  const view = fixture();
  await view.search("@Al");
  view.key("Escape");
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  return view;
}

describe("mention query cache", () => {
  it.each(["before", "after"])(
    "keeps an in-flight result when reopened %s it settles",
    async (reopen) => {
      const view = fixture();
      const response = view.defer();
      await view.search("@Al");
      view.key("Escape");
      if (reopen === "before") {
        await view.search("Review @Al");
      }
      await response(people);
      if (reopen === "after") {
        expect(view.query('[role="listbox"]')).toBeNull();
        view.edit("Review @Al");
      }
      expect(view.options()).toHaveLength(2);
      expect(view.request).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes stale results in the background without losing keyboard selection", async () => {
    const view = await staleFixture();
    const response = view.defer();
    view.edit("Review @Al");
    expect(view.options()).toHaveLength(2);
    expect(view.query(".mention-menu__loading")).toBeNull();
    view.key("ArrowDown");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
    await response({ users: people.users.toReversed(), truncated: false });
    view.key("Enter");
    expect(view.value().mentions).toEqual([mention("profile-alex-offline", 7, 12)]);
    expect(view.send).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "network outage", error: new Error("Connection interrupted"), message: null },
    {
      failure: "directory unavailable",
      error: new GatewayRequestError({ code: "UNAVAILABLE", message: "Directory unavailable" }),
      message: null,
    },
    {
      failure: "access revoked",
      error: new GatewayRequestError({ code: "FORBIDDEN", message: "Access revoked" }),
      message: "Mention access denied.",
    },
    {
      failure: "profile unavailable",
      error: new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Profile unavailable",
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      }),
      message: "Profile unverified.",
    },
    {
      failure: "invalid destination",
      error: new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Session was not found.",
      }),
      message: "Mention search rejected.",
    },
  ])("handles a background refresh failure: $failure", async ({ error, message }) => {
    const view = await staleFixture();
    view.request.mockRejectedValueOnce(error);
    await view.search("Review @Al");
    expect(view.options()).toHaveLength(message ? 0 : 2);
    expect(view.query(".mention-menu__retry")).toBeNull();
    if (!message) {
      view.key("Enter");
      expect(view.value().mentions).toHaveLength(1);
    } else {
      expect(view.container.textContent).toContain(message);
      expect(view.container.textContent).not.toContain(error.message);
      view.key("Enter");
      expect(view.value().mentions).toHaveLength(0);
      expect(view.send).not.toHaveBeenCalled();
      view.key("Escape");
      view.edit("Again @Al");
      expect(view.options()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(view.request).toHaveBeenCalledTimes(3);
    }
  });

  it.each(["switch query", "close", "replace owner"])(
    "does not publish an old refresh after %s",
    async (action) => {
      const view = await staleFixture();
      const response = view.defer();
      await view.search("Review @Al");
      if (action === "switch query") {
        view.request.mockResolvedValueOnce({ users: [], truncated: false });
        await view.search("Review @Nobody");
      } else if (action === "close") {
        view.key("Escape");
      } else {
        view.replaceOwner();
      }
      await response(people);
      expect(view.options()).toHaveLength(0);
      if (action === "replace owner") {
        view.edit("Again @Al");
        expect(view.options()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(150);
        expect(view.request).toHaveBeenCalledTimes(3);
      }
    },
  );
  it("backs off failed refreshes without extending the snapshot's maximum age", async () => {
    const view = await staleFixture();
    view.request.mockRejectedValue(new Error("Connection interrupted"));
    await view.search("Review @Al");
    view.key("Escape");
    await view.search("Again @Al");
    expect(view.request).toHaveBeenCalledTimes(2);
    expect(view.options()).toHaveLength(2);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(30_000);
    await view.search("Retry @Al");
    expect(view.request).toHaveBeenCalledTimes(3);
    view.key("Escape");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    view.edit("Expired @Al");
    expect(view.options()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.container.textContent).toContain("Retry");
  });

  it("keeps only sixteen successful exact-query snapshots across picker openings", async () => {
    const view = fixture();
    for (let index = 0; index < 17; index += 1) {
      await view.search(`@Person ${index}`);
      view.key("Escape");
    }
    view.edit("@Person 16");
    expect(view.options()).toHaveLength(2);
    view.key("Escape");
    view.edit("@Person 0");
    expect(view.options()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(18);
  });

  it("fences other pending successes when identity verification is lost", async () => {
    const view = fixture();
    const old = createDeferred<UsersMentionableResult>();
    view.request.mockReturnValueOnce(old.promise).mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Profile unavailable",
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      }),
    );
    await view.search("@Al");
    await view.search("@Other");
    old.resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    view.edit("@Al");
    expect(view.options()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(3);
  });
  it("releases a stalled lookup at its deadline and accepts a fresh retry", async () => {
    const view = fixture();
    const protocol = new GatewayPendingRequests({
      createRequestId: () => "mentions",
      nowMs: Date.now,
    });
    const sent: Array<{ id: string }> = [];
    view.request.mockImplementation((method, params, options) =>
      protocol.request({ send: (frame) => sent.push(JSON.parse(frame)) }, method, params, options),
    );
    await view.search("@Al");
    view.key("Escape");
    await view.search("Review @Al");
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view.container.textContent).toContain("Retry");
    view.key("Escape");
    await view.search("Again @Al");
    expect(sent).toHaveLength(2);
    protocol.handleResponse({
      type: "res",
      id: sent[0]!.id,
      ok: true,
      payload: { users: [], truncated: false },
    });
    protocol.handleResponse({ type: "res", id: sent[1]!.id, ok: true, payload: people });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.options()).toHaveLength(2);
    view.key("Enter");
    expect(view.value().mentions).toHaveLength(1);
  });
});

it.each(["pending", "denied"])(
  "fences reused directory descriptors while a replacement is %s",
  async (replacement) => {
    vi.useFakeTimers();
    const menu = createHumanMentionMenu();
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
    const input = { value: "@Al", selectionStart: 3, selectionEnd: 3 };
    menu.syncDirectory(directory);
    menu.update(input, "trigger");
    await vi.advanceTimersByTimeAsync(150);
    menu.syncDirectory(other);
    menu.syncDirectory(directory);
    menu.update(input, "trigger");
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
    menu.update(input, "trigger");
    expect(menu.activeLabel()).toBe("");
    await vi.advanceTimersByTimeAsync(150);
    expect(request).toHaveBeenCalledTimes(replacement === "pending" ? 2 : 3);
    current.resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.activeLabel()).toBe("Fresh");
  },
);
