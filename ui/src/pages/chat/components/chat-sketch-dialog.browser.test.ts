import { createSignal } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import { registerChatSketchEnglish } from "../../../i18n/locales/en-chat-sketch.ts";
import { releaseChatAttachmentPayload } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ChatSessionRailElement } from "./chat-session-rail.tsx";
import { openChatSketch } from "./chat-sketch-dialog.tsx";
import "./chat-session-rail.tsx";

registerChatSketchEnglish();

async function open(controls: ChatAttachmentControlsProps = {}) {
  const controller = new AbortController();
  const closed = openChatSketch(() => ({ ...controls, readSignal: controller.signal }));
  onTestFinished(async () => {
    controller.abort();
    await closed;
  });
  await expect.element(page.getByRole("button", { name: "Attach sketch" })).toBeVisible();
  return { canvas: document.querySelector("canvas")!, closed };
}

it("keeps a click-only dot visible after pointer release and removes it on undo", async () => {
  const { canvas } = await open();
  await page.elementLocator(canvas).click();
  const drawing = canvas.getContext("2d")!;
  const center = () => [...drawing.getImageData(400, 225, 1, 1).data];
  const background = () => [...drawing.getImageData(0, 0, 1, 1).data];
  expect(center()).not.toEqual(background());
  await page.getByRole("button", { name: "Undo stroke" }).click();
  expect(center()).toEqual(background());
  await expect.element(page.getByRole("button", { name: "Attach sketch" })).toBeDisabled();
});

it("retains a rejected drawing for retry and closes only after destination acceptance", async () => {
  let accept = false;
  let attempts = 0;
  const { canvas, closed } = await open({
    onAttachmentsChange: (next) => {
      attempts++;
      for (const attachment of next) {
        releaseChatAttachmentPayload(attachment.id);
      }
      return accept;
    },
  });
  await page.elementLocator(canvas).click();
  const before = canvas.toDataURL();
  await page.getByRole("button", { name: "Attach sketch" }).click();
  expect(attempts).toBe(1);
  expect(canvas.isConnected).toBe(true);
  expect(canvas.toDataURL()).toBe(before);
  accept = true;
  await page.getByRole("button", { name: "Attach sketch" }).click();
  await closed;
  expect(attempts).toBe(2);
  expect(canvas.isConnected).toBe(false);
});

it("retires the drawing when its composer is hidden and rejects a late opening", async () => {
  const [presented, setPresented] = createSignal(true);
  const controls = {
    get cameraActive() {
      return presented();
    },
  };
  const { canvas, closed } = await open(controls);
  await page.elementLocator(canvas).click();
  setPresented(false);
  await expect.poll(() => canvas.isConnected, { timeout: 1000 }).toBe(false);
  await closed;
  await openChatSketch(() => controls);
  expect(document.querySelector("canvas")).toBeNull();
});

it("keeps a closed side-chat menu bound to live rail presentation", async () => {
  const rail = document.createElement("openclaw-chat-session-rail") as ChatSessionRailElement;
  Object.assign(rail, { sessionKey: "agent:main:test", connected: true, presented: true });
  document.body.append(rail);
  onTestFinished(async () => {
    if (document.querySelector("canvas")) {
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    rail.remove();
  });
  await rail.updateComplete;
  await page.getByRole("button", { name: "Add attachment", exact: true }).click();
  await page.getByText("Draw a sketch", { exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Attach sketch" })).toBeVisible();
  const canvas = document.querySelector("canvas")!;
  rail.presented = false;
  await rail.updateComplete;
  await expect.poll(() => canvas.isConnected, { timeout: 1000 }).toBe(false);
});
