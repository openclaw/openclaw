/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import {
  composerFixture,
  people,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { createComposerProps, findPrimaryButton } from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

afterEach(resetMentionComposerFixture);

it("keeps ordinary edits around a selected person off the pane render path", () => {
  const container = document.createElement("div");
  let draft = "@Alex ";
  let mentions: readonly HumanMention[] = [{ profileId: "alex", start: 0, end: 5 }];
  const props = createComposerProps({
    draft,
    mentions,
    getDraft: () => draft,
    getMentions: () => mentions,
    onDraftChange: (next, selected: readonly HumanMention[] = mentions) => {
      draft = next;
      mentions = selected;
    },
  });
  const redraw = vi.fn(() => render(renderChatComposer({ ...props, draft, mentions }), container));
  props.onRequestUpdate = redraw;
  render(renderChatComposer(props), container);
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const edit = (value: string, start: number, end = start) => {
    textarea.setSelectionRange(start, end);
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }),
    );
    textarea.value = value;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  };

  edit("@Alex please review", 6);
  edit("Ask @Alex please review", 0);
  expect(redraw).not.toHaveBeenCalled();
  expect(draft).toBe("Ask @Alex please review");
  expect(mentions).toEqual([{ profileId: "alex", start: 4, end: 9 }]);
  expect(container.querySelector(".composer-context-strip__person-name")?.textContent).toBe("Alex");

  edit("Ask @Alix please review", 7, 8);
  expect(redraw).toHaveBeenCalledOnce();
  expect(mentions).toEqual([]);
  expect(container.querySelector(".composer-context-strip")).toBeNull();
});

describe("chat inline commands with human mentions", () => {
  it("sends an ordinary message with its recipient while history loads", () => {
    const mention = { profileId: "profile-alex-online", start: 7, end: 12 };
    const draft = "Review @Alex";
    const view = composerFixture("chat", draft, [mention], "Loading chat");

    view.edit(draft);
    view.key("Escape");
    view.key("Enter");

    expect(view.slashCommand).not.toHaveBeenCalled();
    expect(view.send).toHaveBeenCalledExactlyOnceWith({ draft, mentions: [mention] });
  });

  it.each([
    { input: "keyboard", history: "ready", action: "command" },
    { input: "keyboard", history: "loading", action: "held" },
    { input: "button", history: "ready", action: "message" },
    { input: "button", history: "loading", action: "message" },
  ])("handles appended commands via $input with history $history", ({ input, history, action }) => {
    const mention = { profileId: "profile-alex-online", start: 7, end: 12 };
    const draft = "Review @Alex /dashboard release health";
    const view = composerFixture(
      "chat",
      "Review @Alex",
      [mention],
      history === "loading" ? "Loading chat" : undefined,
    );

    view.edit(draft);
    if (input === "keyboard") {
      view.key("Enter");
    } else {
      findPrimaryButton(view.container).click();
    }

    if (action === "command") {
      expect(view.slashCommand).toHaveBeenCalledExactlyOnceWith("/dashboard release health");
    } else {
      expect(view.slashCommand).not.toHaveBeenCalled();
    }
    if (action === "message") {
      expect(view.send).toHaveBeenCalledExactlyOnceWith({ draft, mentions: [mention] });
    } else {
      expect(view.send).not.toHaveBeenCalled();
    }
    expect(view.value()).toEqual({
      draft: action === "command" ? "Review @Alex " : draft,
      mentions: [mention],
    });
  });
});

describe.each(["chat", "new-session"] as const)("%s human mentions", (kind) => {
  it("navigates the full list with Home, End, and wrapping arrows before inserting", async () => {
    const view = composerFixture(kind);
    view.edit("@");
    await vi.advanceTimersByTimeAsync(150);
    for (const [key, selectedIndex] of [
      ["End", 1],
      ["ArrowDown", 0],
      ["ArrowUp", 1],
      ["Home", 0],
    ] as const) {
      expect(view.key(key).defaultPrevented).toBe(true);
      const options = view.container.querySelectorAll('[role="option"]');
      const selected = view.container.querySelector('[role="option"][aria-selected="true"]');
      expect(selected).toBe(options[selectedIndex]);
      expect(view.container.querySelector("textarea")?.getAttribute("aria-activedescendant")).toBe(
        selected?.id,
      );
    }
    for (const key of ["Home", "End"]) {
      for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
        expect(view.key(key, { [modifier]: true }).defaultPrevented).toBe(false);
        expect(view.container.querySelector('[role="option"][aria-selected="true"]')).toBe(
          view.container.querySelector('[role="option"]'),
        );
      }
    }
    view.key("Tab");
    expect(view.value().mentions).toEqual([{ profileId: "profile-alex-online", start: 0, end: 5 }]);
    expect(view.send).not.toHaveBeenCalled();
  });

  it.each(["single edit", "consecutive edits"])(
    "retains the selected person through %s, reordered results, and cached queries",
    async (editing) => {
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
      view.edit("@");
      await vi.advanceTimersByTimeAsync(150);
      view.key("ArrowDown");
      let resolve!: (result: UsersMentionableResult) => void;
      view.request.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      view.edit("@a");
      if (editing === "consecutive edits") {
        await vi.advanceTimersByTimeAsync(50);
        view.edit("@an");
      }
      await vi.advanceTimersByTimeAsync(150);
      expect(view.container.querySelector('[role="option"]')).toBeNull();
      resolve({ users: [roster.users[2]!, roster.users[0]!, roster.users[1]!], truncated: false });
      await vi.advanceTimersByTimeAsync(0);
      const selectedName = () =>
        view.container.querySelector('[role="option"][aria-selected="true"]')?.textContent;
      expect(selectedName()).toContain("Annie");
      view.edit("@");
      expect(selectedName()).toContain("Annie");
      expect(view.request).toHaveBeenCalledTimes(2);
      view.request.mockResolvedValueOnce({ users: [roster.users[2]!], truncated: false });
      view.edit("@anne");
      await vi.advanceTimersByTimeAsync(150);
      expect(selectedName()).toContain("Anne");
      view.key("Enter");
      expect(view.value()).toEqual({
        draft: "@Anne ",
        mentions: [{ profileId: "anne", start: 0, end: 5 }],
      });
      expect(view.send).not.toHaveBeenCalled();
    },
  );

  it.each(["select", "close", "owner change"])(
    "retries a failed query without sending and handles %s before its result",
    async (next) => {
      const view = composerFixture(kind);
      view.request.mockRejectedValueOnce(new Error("Directory unavailable"));
      view.edit("@Al");
      await vi.advanceTimersByTimeAsync(150);
      expect(view.key("Enter").defaultPrevented).toBe(true);
      expect(view.send).not.toHaveBeenCalled();
      const retry = Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeDefined();
      let resolve!: (result: UsersMentionableResult) => void;
      view.request.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      retry!.click();
      await vi.advanceTimersByTimeAsync(150);
      expect(view.request).toHaveBeenCalledTimes(2);
      expect(view.request).toHaveBeenLastCalledWith(
        "users.mentionable",
        {
          ...(kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" }),
          query: "Al",
        },
        { timeoutMs: 15_000 },
      );
      if (next === "close") {
        view.key("Escape");
      } else if (next === "owner change") {
        view.replaceOwner();
      }
      resolve(people);
      await vi.advanceTimersByTimeAsync(0);
      if (next === "select") {
        expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
        view.key("Enter");
        expect(view.value().mentions).toEqual([
          { profileId: "profile-alex-online", start: 0, end: 5 },
        ]);
      } else {
        expect(view.container.querySelector('[role="listbox"]')).toBeNull();
        expect(view.value()).toEqual({ draft: "@Al", mentions: [] });
      }
      expect(view.send).not.toHaveBeenCalled();
    },
  );

  it("keeps the current typed query selectable during ordinary Gateway event traffic", async () => {
    const view = composerFixture(kind);
    let resolve!: (result: UsersMentionableResult) => void;
    view.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    view.edit("@", { data: "@" });
    await vi.advanceTimersByTimeAsync(50);
    view.emitEvent("sessions.changed");
    view.edit("@A", { data: "A" });
    await vi.advanceTimersByTimeAsync(50);
    view.emitEvent("presence");
    view.edit("@Al", { data: "l" });
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledExactlyOnceWith(
      "users.mentionable",
      {
        ...(kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" }),
        query: "Al",
      },
      { timeoutMs: 15_000 },
    );
    view.emitEvent("sessions.changed");
    resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    view.emitEvent("presence");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({
      draft: "@Alex ",
      mentions: [{ profileId: "profile-alex-online", start: 0, end: 5 }],
    });
  });

  it("searches each new query and restores only exact cached results", async () => {
    const view = composerFixture(kind);
    const roster: UsersMentionableResult = {
      users: [
        { profileId: "harper", displayName: "Harper", online: true },
        { profileId: "henry", displayName: "Henry", online: false },
        { profileId: "robin", displayName: "Robin", online: false },
      ],
      truncated: false,
    };
    view.request
      .mockResolvedValueOnce(roster)
      .mockResolvedValueOnce({ users: roster.users.slice(0, 2), truncated: false })
      .mockResolvedValueOnce({ users: roster.users.slice(0, 1), truncated: false });
    for (const [query, count, requests] of [
      ["@", 3, 1],
      ["@h", 2, 2],
      ["@ha", 1, 3],
      ["@h", 2, 3],
      ["@", 3, 3],
    ] as const) {
      view.edit(query);
      await vi.advanceTimersByTimeAsync(150);
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(count);
      expect(view.request).toHaveBeenCalledTimes(requests);
    }
    view.edit("@ha");
    view.key("Enter");
    expect(view.value()).toEqual({
      draft: "@Harper ",
      mentions: [{ profileId: "harper", start: 0, end: 7 }],
    });
  });

  it.each(["", "ste"])(
    "keeps verified-login matches when refining a cached %j query",
    async (prefix) => {
      const view = composerFixture(kind);
      const roster: UsersMentionableResult = {
        users: [
          { profileId: "profile-peter", displayName: "Peter Steinberger", online: true },
          { profileId: "profile-other", displayName: "steipete", online: false },
        ],
        truncated: false,
      };
      view.request.mockResolvedValue(roster);
      view.edit(`@${prefix}`);
      await vi.advanceTimersByTimeAsync(150);
      view.edit("@steipete", { data: "steipete".slice(prefix.length) });
      await vi.advanceTimersByTimeAsync(150);

      expect(view.request).toHaveBeenLastCalledWith(
        "users.mentionable",
        {
          ...(kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" }),
          query: "steipete",
        },
        { timeoutMs: 15_000 },
      );
      expect(view.request).toHaveBeenCalledTimes(2);
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(view.value().mentions).toEqual([]);
      view.key("Enter");
      expect(view.value()).toEqual({
        draft: "@Peter Steinberger ",
        mentions: [{ profileId: "profile-peter", start: 0, end: 18 }],
      });
      expect(view.send).not.toHaveBeenCalled();
    },
  );

  it.each(["debouncing", "in flight"])(
    "ends a bare @ search on space while %s and keeps subsequent prose as text",
    async (phase) => {
      const prefix = "Please review the proposal and keep the literal symbol ";
      const suffix = " in the final explanation without notifying anyone";
      const view = composerFixture(kind, `${prefix}${suffix}`);
      let resolve: ((result: UsersMentionableResult) => void) | undefined;
      view.request.mockImplementation(
        () =>
          new Promise<UsersMentionableResult>((done) => {
            resolve = done;
          }),
      );
      view.edit(`${prefix}@${suffix}`, {
        start: prefix.length,
        caret: prefix.length + 1,
        data: "@",
      });
      expect(view.container.querySelector(".mention-menu")).not.toBeNull();
      if (phase === "in flight") {
        await vi.advanceTimersByTimeAsync(150);
      }
      view.edit(`${prefix}@ ${suffix}`, {
        start: prefix.length + 1,
        caret: prefix.length + 2,
        data: " ",
      });
      expect(view.container.querySelector(".mention-menu")).toBeNull();
      resolve?.(people);
      const draft = `${prefix}@ as plain text${suffix}`;
      view.edit(draft, {
        start: prefix.length + 2,
        caret: prefix.length + "@ as plain text".length,
        data: "as plain text",
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(view.container.querySelector(".mention-menu")).toBeNull();
      expect(view.request).toHaveBeenCalledTimes(phase === "in flight" ? 1 : 0);
      view.key("Enter");
      expect(view.send).toHaveBeenCalledExactlyOnceWith({ draft, mentions: [] });
    },
  );

  it.each(["pointerup", "keyup", "forward selection", "backward selection"])(
    "closes the picker after %s moves beyond the active mention",
    async (eventType) => {
      const prefix = "Please review ";
      const suffix = "the written instructions and leave the rest unchanged";
      const view = composerFixture(kind, `${prefix}${suffix}`);
      const draft = `${prefix}@${suffix}`;
      view.edit(draft, { start: prefix.length, caret: prefix.length + 1, data: "@" });
      const textarea = view.container.querySelector("textarea")!;
      const selecting = eventType.endsWith("selection");
      textarea.setSelectionRange(
        selecting ? prefix.length + 1 : draft.length,
        draft.length,
        eventType === "backward selection" ? "backward" : "forward",
      );
      textarea.dispatchEvent(
        eventType === "keyup" || selecting
          ? new KeyboardEvent("keyup", { bubbles: true, key: "End", shiftKey: selecting })
          : new Event("pointerup", { bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(view.container.querySelector(".mention-menu")).toBeNull();
      expect(view.request).not.toHaveBeenCalled();
      view.key("Enter");
      expect(view.send).toHaveBeenCalledExactlyOnceWith({ draft, mentions: [] });
    },
  );

  it.each(["earlier name part", "original end", "edited name part"])(
    "selects the whole full-name target from %s",
    async (position) => {
      const view = composerFixture(kind);
      const draft = "@Peter Steinberger";
      view.request.mockResolvedValue({
        users: [{ profileId: "profile-peter", displayName: "Peter Steinberger", online: true }],
        truncated: false,
      });
      view.edit(draft);
      await vi.advanceTimersByTimeAsync(150);
      const textarea = view.container.querySelector("textarea")!;
      const carets =
        position === "original end" ? ["@Peter".length, draft.length] : ["@Peter".length];
      for (const caret of carets) {
        textarea.setSelectionRange(caret, caret);
        textarea.dispatchEvent(new Event("pointerup", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(150);
        expect(view.container.querySelector(".mention-menu")).not.toBeNull();
      }
      if (position === "edited name part") {
        view.edit("@Peterx Steinberger", { start: 6, caret: 7, data: "x" });
        await vi.advanceTimersByTimeAsync(150);
      }
      view.key("Enter");
      expect(view.value()).toEqual({
        draft: "@Peter Steinberger ",
        mentions: [{ profileId: "profile-peter", start: 0, end: 18 }],
      });
      expect(view.send).not.toHaveBeenCalled();
    },
  );

  it.each(["Enter", "Tab"])("selects a typed full name with %s before sending", async (key) => {
    const view = composerFixture(kind);
    view.request.mockResolvedValue({
      users: [{ profileId: "profile-peter", displayName: "Peter Steinberger", online: true }],
      truncated: false,
    });
    for (const [input, data] of [
      ["@", "@"],
      ["@Peter", "Peter"],
      ["@Peter ", " "],
      ["@Peter Steinberger", "Steinberger"],
    ] as const) {
      view.edit(input, { data });
      await vi.advanceTimersByTimeAsync(150);
      expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(1);
      expect(view.value().mentions).toEqual([]);
    }
    expect(view.request).toHaveBeenLastCalledWith(
      "users.mentionable",
      {
        ...(kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" }),
        query: "Peter Steinberger",
      },
      { timeoutMs: 15_000 },
    );
    expect(view.key(key).defaultPrevented).toBe(true);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({
      draft: "@Peter Steinberger ",
      mentions: [{ profileId: "profile-peter", start: 0, end: 18 }],
    });
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith(view.value());
  });

  it.each([
    {
      label: "truncated",
      query: "@ha",
      result: {
        users: [{ profileId: "harper", displayName: "Harper", online: true }],
        truncated: true,
      },
    },
    {
      label: "unrelated",
      query: "@r",
      result: {
        users: [{ profileId: "harper", displayName: "Harper", online: true }],
        truncated: false,
      },
    },
    {
      label: "server-only match",
      query: "@ha",
      result: {
        users: [{ profileId: "harper", displayName: "Robin", online: true }],
        truncated: false,
      },
    },
    {
      label: "disambiguated name",
      query: "@ha",
      result: {
        users: [{ profileId: "harper01", displayName: "Henry (harper01)", online: true }],
        truncated: false,
      },
    },
  ])("refetches $label queries and preserves exact cached results", async ({ query, result }) => {
    const view = composerFixture(kind);
    view.request.mockResolvedValueOnce(result).mockResolvedValue({ users: [], truncated: false });
    view.edit("@h");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(1);
    view.edit(query);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
    view.edit("@h");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
  });

  it("keeps server-locale matching authoritative for case-sensitive query identities", async () => {
    const view = composerFixture(kind);
    const dotless = {
      users: [{ profileId: "isik", displayName: "Işık", online: true }],
      truncated: false,
    };
    const dotted = {
      users: [{ profileId: "ipek", displayName: "İpek", online: true }],
      truncated: false,
    };
    view.request.mockResolvedValueOnce(dotless).mockResolvedValueOnce(dotted);
    view.edit("@I");
    await vi.advanceTimersByTimeAsync(150);
    view.edit("@i");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("İpek");
    expect(view.container.textContent).not.toContain("Işık");
    view.edit("@I");
    expect(view.container.textContent).toContain("Işık");
    expect(view.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Ipek", "i"],
    ["J\u0301onas", "j\u0301"],
  ])("refetches locale-sensitive names such as %s", async (displayName, query) => {
    const view = composerFixture(kind);
    view.request
      .mockResolvedValueOnce({
        users: [{ profileId: "person", displayName, online: true }],
        truncated: false,
      })
      .mockResolvedValueOnce({ users: [], truncated: false });
    view.edit("@");
    await vi.advanceTimersByTimeAsync(150);
    view.edit(`@${query}`);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it("fences late searches when restoring a cached query and clears snapshots on owner change", async () => {
    const view = composerFixture(kind);
    view.edit("@A");
    await vi.advanceTimersByTimeAsync(150);
    let resolve!: (result: UsersMentionableResult) => void;
    view.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    view.edit("@B");
    await vi.advanceTimersByTimeAsync(150);
    view.edit("@A");
    resolve({ users: [], truncated: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(view.request).toHaveBeenCalledTimes(2);
    view.replaceOwner();
    view.edit("@A");
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).toHaveBeenCalledTimes(3);
  });

  it("selects an offline same-name profile before Enter can send", async () => {
    const view = composerFixture(kind);
    view.edit("@Al", { data: "@Al" });
    await vi.advanceTimersByTimeAsync(150);
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(view.container.textContent).not.toContain("Offline");
    view.key("ArrowDown");
    expect(view.key("Enter").defaultPrevented).toBe(true);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.value()).toEqual({
      draft: "@Alex ",
      mentions: [{ profileId: "profile-alex-offline", start: 0, end: 5 }],
    });
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain("Will notify");
    expect(view.container.querySelector('[role="status"]')?.textContent).not.toContain("@Alex");
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith(view.value());
  });

  it("shows the selected full name and removes notification without changing its draft", async () => {
    const view = composerFixture(kind);
    view.request.mockResolvedValue({
      users: [{ profileId: "jordan", displayName: "Jordan Rivera", online: true }],
      truncated: false,
    });
    view.edit("@Jo");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Enter");
    const status = view.container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("Will notify");
    expect(status.textContent).toContain("Jordan Rivera");
    expect(status.textContent).not.toContain("Will notify:");
    expect(status.textContent).not.toContain("@Jordan Rivera");
    expect(status.querySelector('[role="img"][aria-label="Jordan Rivera"]')).not.toBeNull();
    expect(status.querySelector('[title="@Jordan Rivera"]')).not.toBeNull();
    expect(view.value()).toEqual({
      draft: "@Jordan Rivera ",
      mentions: [{ profileId: "jordan", start: 0, end: 14 }],
    });
    status.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')!.click();
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith({ draft: "@Jordan Rivera ", mentions: [] });
    expect(view.container.textContent).not.toContain("Will notify");
  });

  it("keeps the remaining same-name recipient after deleting the first token", () => {
    const view = composerFixture(kind, "@Alex @Alex", [
      { profileId: "first-alex", start: 0, end: 5 },
      { profileId: "second-alex", start: 6, end: 11 },
    ]);
    view.edit("@Alex", { start: 0, end: 6, inputType: "deleteContentBackward", data: null });
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith({
      draft: "@Alex",
      mentions: [{ profileId: "second-alex", start: 0, end: 5 }],
    });
  });

  it("invalidates edited tokens and never rebinds pasted names", () => {
    const view = composerFixture(kind, "@Alex", [{ profileId: "alex", start: 0, end: 5 }]);
    view.edit("@Alx", { start: 3, end: 4, inputType: "deleteContentForward", data: null });
    expect(view.value().mentions).toEqual([]);
    expect(view.container.textContent).not.toContain("Will notify");
    view.edit("@Alex", { start: 0, end: 4, inputType: "insertFromPaste" });
    view.key("Enter");
    expect(view.send).toHaveBeenCalledWith({ draft: "@Alex", mentions: [] });
    expect(view.request).not.toHaveBeenCalled();
  });

  it.each([
    "email@Alex",
    "`@Alex",
    "> @Alex",
    "```\n@Alex",
    "email@Peter Steinberger",
    "`@Peter Steinberger",
    "> @Peter Steinberger",
    "```\n@Peter Steinberger",
    "/command @Peter Steinberger",
  ])("keeps %j as plain text", async (text) => {
    const view = composerFixture(kind);
    view.edit(text);
    await vi.advanceTimersByTimeAsync(150);
    expect(view.request).not.toHaveBeenCalled();
    expect(view.value().mentions).toEqual([]);
  });

  it.each(["insertFromPaste", "insertFromDrop"])(
    "never binds a full name from %s",
    async (inputType) => {
      const view = composerFixture(kind);
      view.edit("@Peter Steinberger", { inputType });
      await vi.advanceTimersByTimeAsync(150);
      view.key("Enter");
      expect(view.request).not.toHaveBeenCalled();
      expect(view.send).toHaveBeenCalledWith({ draft: "@Peter Steinberger", mentions: [] });
    },
  );

  it.each(["@Peter Steinberger", "@Peter\nSteinberger"])(
    "sends %j without recipients when no person was selected",
    async (draft) => {
      const view = composerFixture(kind);
      view.edit("@Peter", { data: "@Peter" });
      await vi.advanceTimersByTimeAsync(150);
      view.edit(draft, { data: draft.slice("@Peter".length) });
      await vi.advanceTimersByTimeAsync(150);
      if (draft.includes("\n")) {
        expect(view.container.querySelector('[role="listbox"]')).toBeNull();
        expect(view.request).toHaveBeenCalledTimes(1);
      } else {
        view.key("Escape");
      }
      view.key("Enter");
      expect(view.send).toHaveBeenCalledWith({ draft, mentions: [] });
    },
  );

  it("lets Escape close the picker without aborting and ignores composition Enter", async () => {
    const view = composerFixture(kind);
    view.edit("@");
    await vi.advanceTimersByTimeAsync(150);
    view.key("Enter", { isComposing: true });
    expect(view.value().mentions).toEqual([]);
    view.key("Escape");
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(view.send).not.toHaveBeenCalled();
    expect(view.abort).not.toHaveBeenCalled();
  });

  it("discards suggestions resolved after the draft owner changes", async () => {
    const view = composerFixture(kind);
    let resolve!: (result: UsersMentionableResult) => void;
    view.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    view.edit("@");
    await vi.advanceTimersByTimeAsync(150);
    view.replaceOwner();
    resolve(people);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });
});

it("blocks unsupported sends until the operator explicitly removes selected mentions", () => {
  const view = composerFixture("chat", "@Alex", [{ profileId: "alex", start: 0, end: 5 }]);
  view.setUnsupported();
  view.key("Enter");
  expect(view.send).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Human mentions are not available in this mode");
  view.container.querySelector<HTMLButtonElement>('button[aria-label="Remove mention"]')?.click();
  view.key("Enter");
  expect(view.send).toHaveBeenCalledWith({ draft: "@Alex", mentions: [] });
});
