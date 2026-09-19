/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  createAttachmentSidebarHarness,
  renderAttachmentHarness,
} from "./chat-attachment-picker.test-support.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createPasteEvent, renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
});
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
});

it("opens a pasted text excerpt in the side panel with the text-field action", async () => {
  // This case verifies sidebar actions, not cold Vite transformation of the lazy parser.
  await import("../../lib/chat/pasted-text-excerpt.ts");
  let attachments: ChatAttachment[] = [];
  onTestFinished(() => releaseChatAttachmentPayloads(attachments));
  let container = renderAttachmentHarness(
    () => attachments,
    (next) => {
      attachments = next;
    },
  );
  const textarea = expectDefined(
    container.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea"),
    "composer textarea",
  );
  const text = `First words from a long pasted note ${"x".repeat(1100)}`;
  textarea.dispatchEvent(createPasteEvent(text));
  const sidebar = createAttachmentSidebarHarness();
  container = renderChatView({ attachments, onOpenSidebar: sidebar.open });
  document.body.append(container);

  await waitForFast(() => {
    expect(container.querySelector(".chat-selection-annotations__chip")?.textContent).toContain(
      "First words from a long pasted…",
    );
  });
  expect(attachments[0]?.origin).toBe("paste");
  expect(container.querySelector("openclaw-chat-pasted-text openclaw-tooltip")).toBeNull();
  expectDefined(
    container.querySelector(".chat-selection-annotations__chip"),
    "pasted text chip",
  ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(sidebar.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "attachment", plainText: true, mimeType: "text/plain" }),
  );
  expect(sidebar.container.querySelector(".chat-attachment-text-action")?.textContent?.trim()).toBe(
    "Show in text field",
  );
});
