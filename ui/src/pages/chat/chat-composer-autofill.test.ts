/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";

afterEach(() => resetChatViewState());

it("opts the chat composer out of browser form AutoFill", () => {
  const container = renderChatView();

  expect(container.querySelector("textarea")?.getAttribute("autocomplete")).toBe("off");
});
