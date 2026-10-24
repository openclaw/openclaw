/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { getComposerTextarea, renderChatView, requireElement } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

it("lets keyboard users bypass transcript controls to reach the composer", () => {
  const container = renderChatView();
  const skip = requireElement(
    container,
    ".chat-composer-skip-link",
    "composer skip link",
  ) as HTMLAnchorElement;
  const transcript = requireElement(container, '[role="log"]', "chat transcript") as HTMLElement;
  const composer = getComposerTextarea(container);

  expect(skip.textContent).toBe(t("chat.actions.skipToComposer"));
  expect(skip.hash).toBe(`#${requireElement(container, ".chat-footer", "composer footer").id}`);
  expect(skip.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

  skip.focus();
  skip.click();

  expect(document.activeElement).toBe(composer);
});

it("falls back to the composer footer when the composer is unavailable", () => {
  const container = renderChatView({
    disabledBanner: { kind: "composer-replacement", text: "This session is archived." },
  });
  const skip = requireElement(
    container,
    ".chat-composer-skip-link",
    "composer skip link",
  ) as HTMLAnchorElement;
  const footer = requireElement(container, ".chat-footer", "composer footer") as HTMLElement;

  expect(container.querySelector("textarea")).toBeNull();
  skip.focus();
  skip.click();

  expect(document.activeElement).toBe(footer);
});
