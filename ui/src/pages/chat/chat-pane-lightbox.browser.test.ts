import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import "../../styles/chat.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { connectPaneTestView, createTestChatPane } from "./chat-pane.test-support.ts";

it("uses selected B's original, dismisses the modal and focuses the retained draft without sending", async () => {
  const client = createGatewayBrowserClientFixture();
  const request = vi.spyOn(client, "request");
  const { pane, state } = createTestChatPane({ client });
  pane.active = true;
  pane.presented = true;
  pane.style.cssText = "display:block; width:900px; height:700px";
  onTestFinished(() => {
    pane.element.remove();
    request.mockRestore();
  });
  // Mount the real pane, composer, lightbox and attachment owners. Only Gateway I/O is synthetic.
  connectPaneTestView(pane);
  document.body.append(pane.element);
  await pane.updateComplete;
  await expect.poll(() => pane.querySelector("textarea")).not.toBeNull();
  const composer = pane.querySelector("textarea")!;
  const draft = "Keep the composition, but make the sky warmer.";
  await userEvent.fill(composer, draft);
  const transfer = new DataTransfer();
  transfer.items.add(new File(["Keep the shoreline."], "art-notes.txt", { type: "text/plain" }));
  composer.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  await expect
    .poll(() => getChatAttachmentDataUrl(state.chatAttachments[0]!))
    .toBe("data:text/plain;base64," + btoa("Keep the shoreline."));
  const retainedAttachment = state.chatAttachments[0]!;
  const images = ["#a9c8d4", "#f4bf83"].map((color, index) => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 80;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = color;
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    const originalSrc = canvas.toDataURL("image/png");
    canvas.width = 32;
    canvas.height = 20;
    return { src: canvas.toDataURL("image/png"), originalSrc, title: "coastal-" + index + ".png" };
  });
  // Native modal return-focus must not make a broken composer-completion focus pass.
  composer.blur();
  expect(document.activeElement).not.toBe(composer);
  state.handleOpenImage({
    ...images[0]!,
    gallery: { index: 0, items: images.map((item) => async () => item) },
  });
  await expect
    .element(page.getByRole("dialog", { name: "Image preview: coastal-0.png", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("dialog", { name: "Image preview: coastal-1.png", exact: true }))
    .toBeVisible();
  const dialog = document.querySelector("openclaw-image-lightbox dialog")!;
  const use = page.getByRole("button", { name: "Use in message", exact: true });
  await use.click();
  await expect.poll(() => document.querySelector("openclaw-image-lightbox")).toBeNull();
  expect(dialog.matches(":modal")).toBe(false);
  await expect.poll(() => state.chatAttachments.length).toBe(2);
  const selected = state.chatAttachments[1]!;
  await expect.poll(() => getChatAttachmentDataUrl(selected)).toBe(images[1]!.originalSrc);
  expect(selected.fileName).toBe("coastal-1.png");
  expect(state.chatAttachments[0]).toBe(retainedAttachment);
  expect(pane.querySelector("textarea")).toBe(composer);
  expect(composer.value).toBe(draft);
  expect(pane.chatState.composerDraft.read().draft).toBe(draft);
  await expect.poll(() => document.activeElement).toBe(composer);
  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
});
