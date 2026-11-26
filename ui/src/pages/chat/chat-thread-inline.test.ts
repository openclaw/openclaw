// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { message } from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import {
  getExpandedToolCards,
  readInlineToolExpansion,
  resetChatThreadState,
  setExpansionState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

it.each([undefined, false])(
  "retains manual choices through inline mode (disabled %s)",
  (disabled) => {
    const sessionKey = "inline-expansion-policy";
    const source = message("assistant", [
      { type: "toolcall", id: "command", name: "exec", arguments: { command: "npm test" } },
      { type: "toolcall", id: "read", name: "read", arguments: { path: "README.md" } },
      { type: "toolcall", id: "search", name: "grep", arguments: { pattern: "TODO" } },
      { type: "toolcall", id: "browser", name: "browser.open", arguments: {} },
    ]);
    const items = groupMessages([{ kind: "message", key: "inline-cards", message: source }]);
    const expanded = getExpandedToolCards(sessionKey);
    const cards = extractToolCardsCached(source);
    const readInline = () =>
      ids.map((id, index) => readInlineToolExpansion(expanded, id, cards[index]));
    const ids = [0, 1, 2, 3].map((index) => `inline-cards:toolcard:${index}`);
    syncToolCardExpansionState(sessionKey, items, true, false, disabled);
    expect(ids.map((id) => expanded.get(id))).toEqual([true, true, true, true]);

    syncToolCardExpansionState(sessionKey, items, true, false, true);
    expect(readInline()).toEqual([false, false, false, true]);
    setExpansionState(expanded, ids[0]!, true);
    setExpansionState(expanded, ids[1]!, false);
    setExpansionState(expanded, ids[3]!, false);
    syncToolCardExpansionState(sessionKey, items, false, false, true);
    syncToolCardExpansionState(sessionKey, items, true, false, true);
    expect(readInline()).toEqual([true, false, false, false]);

    syncToolCardExpansionState(sessionKey, items, true, false, disabled);
    expect(ids.map((id) => expanded.get(id))).toEqual([true, false, true, false]);
  },
);

it("applies inline defaults when search-hidden rows reappear without replacing manual choices", () => {
  const sessionKey = "hidden-inline-expansion";
  const source = message("assistant", [
    { type: "toolcall", id: "default", name: "exec", arguments: { command: "npm test" } },
    { type: "toolcall", id: "manual", name: "exec", arguments: { command: "npm lint" } },
    { type: "toolcall", id: "browser", name: "browser.open", arguments: {} },
  ]);
  const items = groupMessages([{ kind: "message", key: "hidden-cards", message: source }]);
  const expanded = getExpandedToolCards(sessionKey);
  const cards = extractToolCardsCached(source);
  const readInline = () =>
    ids.map((id, index) => readInlineToolExpansion(expanded, id, cards[index]));
  const ids = [0, 1, 2].map((index) => `hidden-cards:toolcard:${index}`);
  syncToolCardExpansionState(sessionKey, items, true);
  setExpansionState(expanded, ids[1]!, true);
  syncToolCardExpansionState(sessionKey, [], true, true, true);
  syncToolCardExpansionState(sessionKey, items, false, false, true);
  expect(readInline()).toEqual([false, true, true]);

  syncToolCardExpansionState(sessionKey, [], false, true);
  syncToolCardExpansionState(sessionKey, items, false);
  expect(ids.map((id) => expanded.get(id))).toEqual([true, true, true]);
  syncToolCardExpansionState(sessionKey, items, true);
  expect(ids.map((id) => expanded.get(id))).toEqual([true, true, true]);
});
