import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AssistantAttachments, MessageAttachment } from "./chat-message-attachments-solid.tsx";
import type { AssistantAttachmentItem } from "./chat-message-media.ts";
import "../../../styles/base.css";
import "../../../styles/chat/layout.css";
import "../../../styles/chat/message-layout.css";

function audioFixture(): Blob {
  const samples = 16_000;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const data = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      data.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  data.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, 8_000, true);
  data.setUint32(28, 16_000, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, samples * 2, true);
  return new Blob([bytes], { type: "audio/wav" });
}

afterEach(cleanupSolid);

it.each([390, 1100])("plays unflagged incoming audio inline at %s px", async (width) => {
  await page.viewport(width, 500);
  document.documentElement.dataset.themeMode = "dark";
  const src = URL.createObjectURL(audioFixture());
  const item: AssistantAttachmentItem = {
    type: "attachment",
    attachment: { kind: "audio", label: "Demo recording.wav", mimeType: "audio/wav", url: src },
  };
  try {
    // The previous incoming-message route used this same explicit card presentation.
    const before = mountSolid(() => (
      <MessageAttachment item={item} options={{}} presentation="card" />
    ));
    await expect.element(page.getByText("Demo recording.wav")).toBeVisible();
    await page.screenshot({ path: `.artifacts/audio-preview/${width}-before.png` });
    before.unmount();
    const view = mountSolid(() => (
      <AssistantAttachments attachments={[item]} options={{}} inlinePlayback={false} />
    ));
    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect.element(play).toBeVisible();
    const media = view.container.querySelector("audio")!;
    await waitForSolid(() => expect(media.duration).toBe(2));
    const card = view.container.querySelector(".chat-assistant-attachment-card")!;
    const bounds = card.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    await page.screenshot({ path: `.artifacts/audio-preview/${width}-after.png` });
    await userEvent.click(play);
    await waitForSolid(() => expect(media.currentTime).toBeGreaterThan(0));
    await userEvent.click(page.getByRole("button", { name: "Pause", exact: true }));
    expect(media.paused).toBe(true);
    const seek = view.container.querySelector<HTMLInputElement>('input[type="range"]')!;
    seek.value = "1";
    seek.dispatchEvent(new Event("input", { bubbles: true }));
    expect(media.currentTime).toBeCloseTo(1, 1);
  } finally {
    cleanupSolid();
    URL.revokeObjectURL(src);
    delete document.documentElement.dataset.themeMode;
  }
});
