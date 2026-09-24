/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";
import type { ChatQueueRecovery } from "./components/chat-queue-recovery.types.ts";

const mounts: HTMLElement[] = [];
afterEach(() => {
  for (const mount of mounts) {
    render(null, mount);
    mount.remove();
  }
  mounts.length = 0;
});
function fixture() {
  const mount = document.body.appendChild(document.createElement("div"));
  mounts.push(mount);
  const queue: ChatQueueItem[] = [
    { id: "first", text: "First queued prompt", createdAt: 1 },
    { id: "second", text: "Second queued prompt", createdAt: 2 },
  ];
  const controls = {
    onQueueMove: vi.fn(),
    onQueueRetry: vi.fn(),
    onQueueSteer: vi.fn(),
    onQueueRemove: vi.fn(),
    canAbort: true,
  };
  const recovery: ChatQueueRecovery = {
    items: [
      {
        id: "saved",
        state: "interrupted",
        acceptedAt: 100,
        message: { role: "user", content: "Saved prompt", __openclaw: { senderName: "Sam" } },
      },
    ],
    onSend: vi.fn(),
    onDiscard: vi.fn(),
  };
  const paint = (saved: ChatQueueRecovery | undefined) =>
    render(renderChatQueue({ queue, ...controls, recovery: saved }), mount);
  return { mount, queue, controls, recovery, paint };
}

it("adds inert rows without altering the real queue, reorder segments, or mounted queue rows", () => {
  const f = fixture();
  f.paint(undefined);
  const before = structuredClone(f.queue);
  const first = f.mount.querySelector('[data-chat-queue-item="first"]');
  const handles = [...f.mount.querySelectorAll<HTMLButtonElement>(".chat-queue__grip")].map(
    (h) => h.disabled,
  );
  f.paint(f.recovery);
  expect(f.mount.querySelectorAll(".chat-queue")).toHaveLength(1);
  expect(f.mount.querySelector('[data-chat-queue-item="first"]')).toBe(first);
  expect(
    [...f.mount.querySelectorAll<HTMLButtonElement>(".chat-queue__grip")].map((h) => h.disabled),
  ).toEqual(handles);
  expect(f.queue).toEqual(before);
  const saved = f.mount.querySelector('[data-chat-recovery-input="saved"]');
  expect(saved?.textContent).toContain("Not started");
  expect(
    saved?.querySelector(
      "[draggable=true],.chat-queue__grip,.chat-queue__steer,.chat-queue__overflow",
    ),
  ).toBeNull();
  expect(saved?.hasAttribute("data-chat-queue-item")).toBe(false);
  f.paint(undefined);
  expect(f.mount.querySelector('[data-chat-queue-item="first"]')).toBe(first);
  expect(f.queue).toEqual(before);
});

it("routes explicit Send and Discard only to saved-attempt callbacks", () => {
  const f = fixture();
  f.paint(f.recovery);
  f.mount.querySelector<HTMLButtonElement>(".chat-queue__recovery-send")?.click();
  f.mount
    .querySelector<HTMLButtonElement>("[data-chat-recovery-input] .chat-queue__remove")
    ?.click();
  expect(f.recovery.onSend).toHaveBeenCalledExactlyOnceWith("saved");
  expect(f.recovery.onDiscard).toHaveBeenCalledExactlyOnceWith("saved");
  for (const action of [
    f.controls.onQueueMove,
    f.controls.onQueueRetry,
    f.controls.onQueueSteer,
    f.controls.onQueueRemove,
  ]) {
    expect(action).not.toHaveBeenCalled();
  }
  expect(f.queue.map((item) => item.id)).toEqual(["first", "second"]);
});

it("renders an inactive cancelled row with no queue blockers or automatic actions", () => {
  const f = fixture();
  f.queue.length = 0;
  f.recovery.items = [{ ...f.recovery.items[0]!, state: "cancelled" }];
  f.paint(f.recovery);
  expect(f.mount.textContent).toContain("Cancelled");
  expect(f.mount.querySelector("[data-chat-queue-global-state]")).toBeNull();
  expect(f.recovery.onSend).not.toHaveBeenCalled();
  expect(f.recovery.onDiscard).not.toHaveBeenCalled();
  expect(f.queue).toEqual([]);
});

it("keeps the row and controls mounted while its explicit action is pending", () => {
  const f = fixture();
  f.paint(f.recovery);
  const row = f.mount.querySelector("[data-chat-recovery-input]");
  const send = f.mount.querySelector<HTMLButtonElement>(".chat-queue__recovery-send");
  f.recovery.busyIds = new Set(["saved"]);
  f.paint(f.recovery);
  expect(f.mount.querySelector("[data-chat-recovery-input]")).toBe(row);
  expect(f.mount.querySelector(".chat-queue__recovery-send")).toBe(send);
  expect(send?.disabled).toBe(true);
  send?.click();
  expect(f.recovery.onSend).not.toHaveBeenCalled();
  expect(f.mount.querySelector(".skeleton,.btn__spinner")).toBeNull();
});

it("ignores a retargeted second click after a prior saved row disappears", () => {
  const f = fixture();
  f.paint(f.recovery);
  for (const selector of [
    ".chat-queue__recovery-send",
    "[data-chat-recovery-input] .chat-queue__remove",
  ]) {
    f.mount
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
  }
  expect(f.recovery.onSend).not.toHaveBeenCalled();
  expect(f.recovery.onDiscard).not.toHaveBeenCalled();
});
