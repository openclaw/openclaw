import { afterEach, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import {
  renderComposer as renderNewSession,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { createSlashRerenderHarness } from "./chat-view.test-helpers.ts";
import "../../styles/base.css";
import "../../styles/chat/composer.css";

afterEach(async () => {
  await resetComposerFixture();
  resetComposerTestFixtures();
});

it.each(["chat", "new-session"] as const)(
  "keeps reverse Tab native with slash suggestions in %s",
  async (surface) => {
    replaceSlashCommands(buildFallbackSlashCommands());
    const chat = surface === "chat" ? createSlashRerenderHarness() : undefined;
    const view = chat ?? renderNewSession();
    const before = document.createElement("button");
    before.textContent = "Before composer";
    document.body.append(before, view.container);
    onTestFinished(() => before.remove());
    let textarea = view.container.querySelector("textarea")!;
    await userEvent.click(textarea);
    textarea.value = "/";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    if (chat) {
      const next = chat.renderCurrent();
      document.body.append(next);
      view.container.remove();
      textarea = next.querySelector("textarea")!;
      textarea.focus();
    }
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.tab({ shift: true });
    expect(textarea.value).toBe("/");
    expect(document.activeElement).not.toBe(textarea);
    expect(document.activeElement).not.toBe(document.body);
  },
);
