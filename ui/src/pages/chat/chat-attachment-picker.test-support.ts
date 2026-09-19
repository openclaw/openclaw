import { render } from "lit";
import { vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
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
