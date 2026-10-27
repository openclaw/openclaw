/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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

function createSubmissionHarness(
  submit: (setDraft: (next: string) => void) => void | Promise<boolean | void>,
) {
  let draft = "";
  const onDraftChange = vi.fn((next: string) => {
    draft = next;
  });
  const container = createComposerContainer();
  const render = () =>
    renderChatInto(container, {
      draft,
      getDraft: () => draft,
      onDraftChange,
      onSend: () => submit(setDraft),
    });
  const setDraft = (next: string) => {
    draft = next;
    render();
  };
  render();
  return { container, readDraft: () => draft };
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
    const onSend = vi.fn((setDraft: (next: string) => void) => {
      if (clears) {
        setDraft("");
      }
    });
    const { container, readDraft } = createSubmissionHarness(onSend);
    inputDraftAtEnd(container, submittedDraft);
    await waitForSolid(() => expect(container.querySelector(selector)).not.toBeNull());

    container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();
    flush();

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

it("settles a command menu after an accepted asynchronous clear", async () => {
  const admitted = createDeferred();
  const completion = createDeferred();
  const { container } = createSubmissionHarness(async (setDraft) => {
    admitted.resolve();
    await completion.promise;
    setDraft("");
  });
  inputDraftAtEnd(container, "/help");
  await waitForSolid(() => expect(container.querySelector(".slash-menu")).not.toBeNull());

  container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();
  await admitted.promise;
  expect(getComposerTextarea(container).value).toBe("/help");
  completion.resolve();

  await waitForSolid(() => {
    expect(getComposerTextarea(container).value).toBe("");
    expect(container.querySelector(".slash-menu")).toBeNull();
  });
});

it("keeps a restored command menu after asynchronous submission failure", async () => {
  const failed = createDeferred();
  const { container } = createSubmissionHarness(async (setDraft) => {
    setDraft("");
    await failed.promise;
    setDraft("/help");
    return false;
  });
  inputDraftAtEnd(container, "/help");
  await waitForSolid(() => expect(container.querySelector(".slash-menu")).not.toBeNull());

  container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();
  failed.resolve();

  await waitForSolid(() => {
    expect(getComposerTextarea(container).value).toBe("/help");
    expect(container.querySelector(".slash-menu")).not.toBeNull();
  });
});
