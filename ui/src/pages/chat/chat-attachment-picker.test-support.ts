import { expectDefined } from "@openclaw/normalization-core";
import { render, type LitElement } from "lit";
import { expect, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import * as attachmentTextReader from "./components/chat-attachment-text-reader.ts";
import type { SidebarContent } from "./components/chat-sidebar-content-types.ts";

export function createAttachmentSidebarHarness() {
  const container = document.createElement("div");
  const open = vi.fn((content: SidebarContent) => {
    if (content.kind !== "attachment") {
      throw new Error("Expected an attachment side panel");
    }
    render(content.renderActions?.(), container);
  });
  return { container, open };
}

export function renderAttachmentHarness(
  getAttachments: () => ChatAttachment[],
  onAttachmentsChange: (attachments: ChatAttachment[]) => void,
) {
  return renderChatView({
    attachments: getAttachments(),
    getAttachments,
    onAttachmentsChange,
  });
}

export async function renderSettledPastedTextAttachment(
  overrides: Parameters<typeof renderChatView>[0],
) {
  const read = vi.spyOn(attachmentTextReader, "readAttachmentText");
  try {
    const container = renderChatView(overrides);
    document.body.append(container);
    const chip = expectDefined(
      container.querySelector<LitElement>("openclaw-chat-pasted-text"),
      "pasted text attachment",
    );
    await chip.updateComplete;
    expect(read).toHaveBeenCalledOnce();
    const result = expectDefined(read.mock.results[0], "pasted text read");
    if (result.type !== "return") {
      throw result.value;
    }
    // The excerpt owns a real body read followed by a lazy parser import and a Lit update.
    // Await those operations instead of racing cold transforms against a polling budget.
    await result.value;
    await vi.dynamicImportSettled();
    await chip.updateComplete;
    return container;
  } finally {
    read.mockRestore();
  }
}

export function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function getAttachmentMenuOption(container: Element, label: string) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(".agent-chat__attach-menu-option"),
  ).find((button) => button.textContent?.trim() === label);
}

export function selectAttachmentMenuOption(button: HTMLButtonElement | undefined) {
  button
    ?.closest("wa-dropdown")
    ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: button }, bubbles: true }));
}

export function requireAttachmentInput(container: Element, selector: string, label: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (input === null) {
    throw new Error(`expected ${label}`);
  }
  return input;
}
