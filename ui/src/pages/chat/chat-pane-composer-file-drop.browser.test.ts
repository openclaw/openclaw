import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import "../../styles.css";
import "../../styles/chat.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { connectPaneTestView, createTestChatPane } from "./chat-pane.test-support.ts";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "attaches one dropped file through the full Chat pane with rich=%s",
  async (rich) => {
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
    pane.active = true;
    pane.style.cssText = "display:block; width:900px; height:700px";
    onTestFinished(() => pane.element.remove());
    // This existing harness mounts the production pane/view and its draft and
    // attachment owners. Do not replace render() or install a test drop handler.
    connectPaneTestView(pane);
    document.body.append(pane.element);
    await pane.updateComplete;
    await expect.poll(() => pane.querySelector("textarea")).not.toBeNull();
    const draft = rich ? "@Alex Review the attached file." : "Review the attached file.";
    pane.state.handleChatDraftChange(
      draft,
      rich ? [{ profileId: "drop-alex", start: 0, end: 5 }] : [],
    );
    const input = expectDefined(pane.querySelector("textarea"), "Chat composer");
    await expect.poll(() => input.value).toBe(draft);
    if (rich) {
      await expect.poll(() => pane.querySelector('[data-composer-editor="true"]')).not.toBeNull();
      expect(pane.querySelectorAll(".chat-composer-mention")).toHaveLength(1);
    } else {
      expect(pane.querySelector('[data-composer-editor="true"]')).toBeNull();
    }
    const target = expectDefined(
      pane.querySelector<HTMLElement>(rich ? '[data-composer-editor="true"]' : "textarea"),
      "visible composer drop target",
    );
    expect(target.closest("section.chat")).not.toBeNull();
    expect(pane.state.chatAttachments).toHaveLength(0);
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const body = "FILE_CONTENT_MUST_NOT_BECOME_MESSAGE_TEXT";
    const transfer = new DataTransfer();
    transfer.items.add(new File([body], "full-chat-drop.txt", { type: "text/plain" }));
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + 4,
        clientY: rect.top + 4,
      }),
    );
    await expect.poll(() => pane.state.chatAttachments.length).toBe(1);
    const attachment = expectDefined(pane.state.chatAttachments[0], "dropped attachment");
    await expect
      .poll(() => getChatAttachmentDataUrl(attachment))
      .toBe("data:text/plain;base64," + btoa(body));
    await expect
      .poll(() => pane.querySelectorAll('.chat-attachment-thumb[aria-busy="false"]').length)
      .toBe(1);
    expect(read).toHaveBeenCalledOnce();
    expect(attachment.fileName).toBe("full-chat-drop.txt");
    expect(pane.state.chatAttachments).toHaveLength(1);
    expect(pane.chatState.composerDraft.read().draft).toBe(draft);
    expect(input.value).toBe(draft);
    expect(target.textContent).not.toContain(body);
  },
);
