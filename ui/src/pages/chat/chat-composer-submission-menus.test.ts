/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  getComposerTextarea,
  inputDraftAtEnd,
  renderChatInto,
  replaceSkillCommands,
} from "./chat-view.test-helpers.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  replaceSlashCommands(buildFallbackSlashCommands());
  resetTranscriptTestDom();
});

function createSubmissionHarness(clears: boolean) {
  let draft = "";
  const onDraftChange = vi.fn((next: string) => {
    draft = next;
  });
  const onSend = vi.fn(() => {
    if (clears) {
      draft = "";
    }
  });
  const container = createComposerContainer();
  const render = () =>
    renderChatInto(container, {
      draft,
      getDraft: () => draft,
      onDraftChange,
      onSend,
    });
  render();
  return { container, onSend, readDraft: () => draft, render };
}

it.each([
  {
    menu: "slash",
    draft: "/help",
    selector: ".slash-menu",
    outcome: "accepted",
    clears: true,
  },
  {
    menu: "skill",
    draft: "Use $pro",
    selector: ".skill-menu",
    outcome: "accepted",
    clears: true,
  },
  {
    menu: "slash",
    draft: "/help",
    selector: ".slash-menu",
    outcome: "retained",
    clears: false,
  },
])(
  "$menu menu follows the $outcome draft without pointer dismissal",
  async ({ menu, draft: submittedDraft, selector, clears }) => {
    if (menu === "skill") {
      replaceSkillCommands({ key: "prose", description: "Draft polished prose." });
    }
    const { container, onSend, readDraft, render } = createSubmissionHarness(clears);
    inputDraftAtEnd(container, submittedDraft);
    await waitForSolid(() => expect(container.querySelector(selector)).not.toBeNull());

    container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();
    flush();
    render();

    expect(onSend).toHaveBeenCalledOnce();
    expect(readDraft()).toBe(clears ? "" : submittedDraft);
    expect(getComposerTextarea(container).value).toBe(clears ? "" : submittedDraft);
    if (clears) {
      await waitForSolid(() => expect(container.querySelector(selector)).toBeNull());
    } else {
      expect(container.querySelector(selector)).not.toBeNull();
    }
  },
);
