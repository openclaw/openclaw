/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  composerFixture,
  mention,
  people,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { findPrimaryButton } from "./chat-composer.test-support.ts";

afterEach(resetMentionComposerFixture);

const peter = { profileId: "profile-peter", displayName: "Peter Steinberger", online: true };
function expectSearch(view: ReturnType<typeof composerFixture>, query: string) {
  expect(view.request).toHaveBeenLastCalledWith(
    "users.mentionable",
    { agentId: "main", query },
    { timeoutMs: 15_000 },
  );
}

it.each([
  { input: "keyboard", history: "loading", action: "ordinary" },
  { input: "keyboard", history: "ready", action: "command" },
  { input: "keyboard", history: "loading", action: "held" },
  { input: "button", history: "loading", action: "message" },
])("handles appended commands via $input with history $history", ({ input, history, action }) => {
  const recipient = mention("profile-alex-online", 7, 12);
  const draft = action === "ordinary" ? "Review @Alex" : "Review @Alex /dashboard release health";
  const view = composerFixture(
    "chat",
    "Review @Alex",
    [recipient],
    history === "loading" ? "Loading chat" : undefined,
  );

  view.edit(draft);
  if (action === "ordinary") {
    view.key("Escape");
  }
  if (input === "keyboard") {
    view.key("Enter");
  } else {
    findPrimaryButton(view.container).click();
  }

  expect(view.slashCommand.mock.calls).toEqual(
    action === "command" ? [["/dashboard release health"]] : [],
  );
  expect(view.send.mock.calls).toEqual(
    action === "message" || action === "ordinary" ? [[{ draft, mentions: [recipient] }]] : [],
  );
  view.expectValue(action === "command" ? "Review @Alex " : draft, [recipient]);
});

describe.each(["chat", "new-session"] as const)("%s human mentions", (kind) => {
  it("navigates and selects an offline same-name profile with Tab before sending", async () => {
    const view = composerFixture(kind);
    await view.search("@");
    for (const [key, selectedIndex] of [
      ["End", 1],
      ["ArrowDown", 0],
      ["ArrowUp", 1],
      ["Home", 0],
    ] as const) {
      expect(view.key(key).defaultPrevented).toBe(true);
      const options = view.options();
      const selected = view.query('[role="option"][aria-selected="true"]');
      expect(selected).toBe(options[selectedIndex]);
      expect(view.query("textarea")?.getAttribute("aria-activedescendant")).toBe(selected?.id);
    }
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
      for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
        expect(view.key(key, { [modifier]: true }).defaultPrevented).toBe(false);
        expect(view.query('[role="option"][aria-selected="true"]')).toBe(view.options()[0]);
      }
    }
    expect(view.container.textContent).not.toContain("Offline");
    view.key("ArrowDown");
    expect(view.key("Tab").defaultPrevented).toBe(true);
    view.expectValue("@Alex ", [mention("profile-alex-offline")]);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.query('[role="status"]')?.textContent).toContain("Will notify");
    expect(view.query('[role="status"]')?.textContent).not.toContain("@Alex");
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith(view.value());
  });

  if (kind === "new-session") {
    it("retains the selected person through consecutive edits, reordered results, and cached queries", async () => {
      const view = composerFixture(kind);
      const roster: UsersMentionableResult = {
        users: [
          { profileId: "anna", displayName: "Anna", online: true },
          { profileId: "annie", displayName: "Annie", online: false },
          { profileId: "anne", displayName: "Anne", online: false },
        ],
        truncated: false,
      };
      view.request.mockResolvedValueOnce(roster);
      await view.search("@");
      view.key("ArrowDown");
      const response = view.defer();
      view.edit("@a");
      await vi.advanceTimersByTimeAsync(50);
      await view.search("@an");
      expect(view.query('[role="option"]')).toBeNull();
      await response({
        users: [roster.users[2]!, roster.users[0]!, roster.users[1]!],
        truncated: false,
      });
      const selectedName = () => view.query('[role="option"][aria-selected="true"]')?.textContent;
      expect(selectedName()).toContain("Annie");
      view.edit("@");
      expect(selectedName()).toContain("Annie");
      expect(view.request).toHaveBeenCalledTimes(2);
      view.request.mockResolvedValueOnce({ users: [roster.users[2]!], truncated: false });
      await view.search("@anne");
      expect(selectedName()).toContain("Anne");
      view.key("Enter");
      view.expectValue("@Anne ", [mention("anne")]);
      expect(view.send).not.toHaveBeenCalled();
    });
    it("retries a failed query without sending and handles selection before its result", async () => {
      const view = composerFixture(kind);
      view.request.mockRejectedValueOnce(new Error("Directory unavailable"));
      await view.search("@Al");
      expect(view.key("Enter").defaultPrevented).toBe(true);
      expect(view.send).not.toHaveBeenCalled();
      const retry = Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeDefined();
      const response = view.defer();
      retry!.click();
      await vi.advanceTimersByTimeAsync(150);
      expect(view.request).toHaveBeenCalledTimes(2);
      expectSearch(view, "Al");
      await response(people);
      expect(view.options()).toHaveLength(2);
      view.key("Enter");
      expect(view.value().mentions).toEqual([mention("profile-alex-online")]);
      expect(view.send).not.toHaveBeenCalled();
    });
    it("ends an in-flight bare @ search on space and keeps subsequent prose as text", async () => {
      const prefix = "Please review the proposal and keep the literal symbol ";
      const suffix = " in the final explanation without notifying anyone";
      const view = composerFixture(kind, `${prefix}${suffix}`);
      const response = createDeferred<UsersMentionableResult>();
      view.request.mockReturnValue(response.promise);
      view.edit(`${prefix}@${suffix}`, {
        start: prefix.length,
        caret: prefix.length + 1,
        data: "@",
      });
      expect(view.query(".mention-menu")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(150);
      view.edit(`${prefix}@ ${suffix}`, {
        start: prefix.length + 1,
        caret: prefix.length + 2,
        data: " ",
      });
      expect(view.query(".mention-menu")).toBeNull();
      response.resolve(people);
      const draft = `${prefix}@ as plain text${suffix}`;
      view.edit(draft, {
        start: prefix.length + 2,
        caret: prefix.length + "@ as plain text".length,
        data: "as plain text",
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(view.query(".mention-menu")).toBeNull();
      expect(view.request).toHaveBeenCalledTimes(1);
      view.key("Enter");
      expect(view.send).toHaveBeenCalledExactlyOnceWith({ draft, mentions: [] });
    });
  }

  it("closes the picker after keyup moves beyond the active mention", async () => {
    const prefix = "Please review ";
    const suffix = "the written instructions and leave the rest unchanged";
    const view = composerFixture(kind, `${prefix}${suffix}`);
    const draft = `${prefix}@${suffix}`;
    view.edit(draft, { start: prefix.length, caret: prefix.length + 1, data: "@" });
    const textarea = view.query<HTMLTextAreaElement>("textarea")!;
    textarea.setSelectionRange(draft.length, draft.length, "forward");
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "End" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(view.query(".mention-menu")).toBeNull();
    expect(view.request).not.toHaveBeenCalled();
    view.key("Enter");
    expect(view.send).toHaveBeenCalledExactlyOnceWith({ draft, mentions: [] });
  });

  it.each(kind === "chat" ? ["original end"] : ["original end", "edited name part", "typed name"])(
    "selects a full-name target from %s",
    async (position) => {
      const view = composerFixture(kind);
      view.request.mockResolvedValue({ users: [peter], truncated: false });
      if (position === "typed name") {
        for (const [input, data] of [
          ["@", "@"],
          ["@Peter", "Peter"],
          ["@Peter ", " "],
          ["@Peter Steinberger", "Steinberger"],
        ] as const) {
          await view.search(input, { data });
          expect(view.options()).toHaveLength(1);
          expect(view.value().mentions).toEqual([]);
        }
        expectSearch(view, "Peter Steinberger");
      } else {
        await view.search("@Peter Steinberger");
        const textarea = view.query<HTMLTextAreaElement>("textarea")!;
        for (const caret of position === "original end" ? [6, 18] : [6]) {
          textarea.setSelectionRange(caret, caret);
          textarea.dispatchEvent(new Event("pointerup", { bubbles: true }));
          await vi.advanceTimersByTimeAsync(150);
          expect(view.query(".mention-menu")).not.toBeNull();
        }
        if (position === "edited name part") {
          await view.search("@Peterx Steinberger", { start: 6, caret: 7, data: "x" });
        }
      }
      expect(view.key(position === "typed name" ? "Tab" : "Enter").defaultPrevented).toBe(true);
      view.expectValue("@Peter Steinberger ", [mention(peter.profileId, 0, 18)]);
      expect(view.send).not.toHaveBeenCalled();
      if (position !== "typed name") {
        return;
      }
      const status = view.query('[role="status"]')!;
      expect(status.textContent).toContain("Will notify");
      expect(status.textContent).toContain("Peter Steinberger");
      expect(status.textContent).not.toContain("Will notify:");
      expect(status.textContent).not.toContain("@Peter Steinberger");
      expect(status.querySelector('[role="img"][aria-label="Peter Steinberger"]')).not.toBeNull();
      expect(status.querySelector('[title="@Peter Steinberger"]')).not.toBeNull();
      status.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
      expect(view.container.textContent).not.toContain("Will notify");
      view.expectValue("@Peter Steinberger ");
      view.key("Enter");
      expect(view.send).toHaveBeenCalledWith(view.value());
    },
  );

  if (kind === "new-session") {
    it("preserves case-sensitive Gateway query identities", async () => {
      const queries = ["I", "i"];
      const results = [
        { users: [{ profileId: "isik", displayName: "Işık", online: true }], truncated: true },
        { users: [{ profileId: "ipek", displayName: "İpek", online: true }], truncated: false },
      ];
      const view = composerFixture(kind);
      view.request.mockResolvedValueOnce(results[0]).mockResolvedValueOnce(results[1]);
      for (const [index, requests] of [
        [0, 1],
        [1, 2],
        [0, 2],
        [1, 2],
      ] as const) {
        await view.search(`@${queries[index]}`);
        expect(view.request).toHaveBeenCalledTimes(requests);
        expect(view.options()).toHaveLength(1);
        expect(view.container.textContent).toContain(results[index]!.users[0]!.displayName);
        expect(view.container.textContent).not.toContain(results[1 - index]!.users[0]!.displayName);
        expect(view.value().mentions).toEqual([]);
      }
      expectSearch(view, queries[1]!);
      view.key("Enter");
      const person = results[1]!.users[0]!;
      view.expectValue(`@${person.displayName} `, [
        mention(person.profileId, 0, person.displayName.length + 1),
      ]);
      expect(view.send).not.toHaveBeenCalled();
    });

    it("fences late searches when restoring a cached query and clears snapshots on owner change", async () => {
      const view = composerFixture(kind);
      await view.search("@A");
      const response = view.defer();
      await view.search("@B");
      view.edit("@A");
      await response({ users: [], truncated: false });
      expect(view.options()).toHaveLength(2);
      expect(view.request).toHaveBeenCalledTimes(2);
      view.replaceOwner();
      await view.search("@A");
      expect(view.request).toHaveBeenCalledTimes(3);
    });
  }

  it.each(kind === "new-session" ? ["first identical label", "edited token"] : ["edited token"])(
    "reconciles recipients after deleting %s",
    (target) => {
      const first = target === "first identical label";
      const view = composerFixture(
        kind,
        first ? "@Alex @Alex" : "@Alex",
        first ? [mention("first-alex"), mention("second-alex", 6, 11)] : [mention("alex")],
      );
      const expected = first ? [mention("second-alex")] : [];
      view.edit(first ? "@Alex" : "@Alx", {
        start: first ? 0 : 3,
        end: first ? 6 : 4,
        inputType: first ? "deleteContentBackward" : "deleteContentForward",
        data: null,
      });
      expect(view.value().mentions).toEqual(expected);
      if (expected.length === 0) {
        expect(view.container.textContent).not.toContain("Will notify");
        view.edit("@Alex", { start: 0, end: 4, inputType: "insertFromPaste" });
        expect(view.request).not.toHaveBeenCalled();
      }
      view.key("Enter");
      expect(view.send).toHaveBeenCalledWith({ draft: "@Alex", mentions: expected });
    },
  );

  if (kind === "new-session") {
    it.each(["`@Peter Steinberger", "```\n@Peter Steinberger", "/command @Peter Steinberger"])(
      "keeps %j as plain text",
      async (text) => {
        const view = composerFixture(kind);
        await view.search(text);
        expect(view.request).not.toHaveBeenCalled();
        expect(view.value().mentions).toEqual([]);
      },
    );

    it("sends a full name without recipients when no person was selected", async () => {
      const draft = "@Peter Steinberger";
      const view = composerFixture(kind);
      await view.search("@Peter", { data: "@Peter" });
      await view.search(draft, { data: draft.slice("@Peter".length) });
      view.key("Enter", { isComposing: true });
      expect(view.value().mentions).toEqual([]);
      view.key("Escape");
      expect(view.query('[role="listbox"]')).toBeNull();
      expect(view.send).not.toHaveBeenCalled();
      expect(view.abort).not.toHaveBeenCalled();
      view.key("Enter");
      expect(view.send).toHaveBeenCalledWith({ draft, mentions: [] });
    });
  }
});

it("blocks unsupported sends until the operator explicitly removes selected mentions", () => {
  const view = composerFixture("chat", "@Alex", [mention("alex")]);
  view.setUnsupported();
  view.key("Enter");
  expect(view.send).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Human mentions are not available in this mode");
  view.container.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')?.click();
  view.key("Enter");
  expect(view.send).toHaveBeenCalledWith({ draft: "@Alex", mentions: [] });
});
