import { afterEach, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import {
  renderComposer as renderNewSession,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
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
    const view = surface === "chat" ? renderComposerFixture() : renderNewSession();
    const before = document.createElement("button");
    before.textContent = "Before composer";
    document.body.append(before, view.container);
    onTestFinished(() => before.remove());
    const textarea = view.container.querySelector("textarea")!;
    await userEvent.fill(textarea, "/to");
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.tab({ shift: true });
    expect(textarea.value).toBe("/to");
    expect(document.activeElement).not.toBe(textarea);
    expect(document.activeElement).not.toBe(document.body);
  },
);
