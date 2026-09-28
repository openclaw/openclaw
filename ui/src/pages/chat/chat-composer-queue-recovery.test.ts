/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";
import { renderChatQueueRecoveryDetails } from "./components/chat-queue-recovery-details.ts";
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
    renderDetails: (input, inspection) =>
      renderChatQueueRecoveryDetails(input, inspection, createChatProps(), () => {}),
  };
  const paint = (saved: ChatQueueRecovery | undefined) =>
    render(renderChatQueue({ queue, ...controls, recovery: saved }), mount);
  return { mount, queue, controls, recovery, paint };
}

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

it("disables Send and Discard while its explicit action is pending", () => {
  const f = fixture();
  f.recovery.busyIds = new Set(["saved"]);
  f.paint(f.recovery);
  const buttons = f.mount.querySelectorAll<HTMLButtonElement>("[data-chat-recovery-input] button");
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button.disabled).toBe(true);
    button.click();
  }
  expect(f.recovery.onSend).not.toHaveBeenCalled();
  expect(f.recovery.onDiscard).not.toHaveBeenCalled();
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

it("opens saved content without replacing normal queue rows or invoking their controls", () => {
  const f = fixture();
  const expanded = new Set<string>();
  f.recovery.expandedIds = expanded;
  f.recovery.renderDetails = () => html`<p>Complete saved message</p>`;
  f.recovery.onToggle = (id, open) => {
    if (open) {
      expanded.add(id);
    } else {
      expanded.delete(id);
    }
    f.paint(f.recovery);
  };
  f.paint(f.recovery);
  const first = f.mount.querySelector("[data-chat-queue-item=first]");
  const details = f.mount.querySelector<HTMLDetailsElement>("[data-chat-recovery-input]")!;
  expect(f.mount.textContent).not.toContain("Complete saved message");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  expect(f.mount.textContent).toContain("Complete saved message");
  expect(f.mount.querySelector("[data-chat-queue-item=first]")).toBe(first);
  expect(f.recovery.onSend).not.toHaveBeenCalled();
  expect(f.controls.onQueueMove).not.toHaveBeenCalled();
  expect(f.queue.map((item) => item.id)).toEqual(["first", "second"]);
});

it("keeps system continuation identity and summary instead of exposing the model prompt", () => {
  const f = fixture();
  f.recovery.items = [
    {
      ...f.recovery.items[0]!,
      message: {
        role: "user",
        content: "PRIVATE_MODEL_CONTINUATION_PAYLOAD",
        provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      },
    },
  ];
  f.paint(f.recovery);
  expect(f.mount.textContent).not.toContain("PRIVATE_MODEL_CONTINUATION_PAYLOAD");
  expect(f.mount.querySelector<HTMLButtonElement>(".chat-queue__recovery-send")?.disabled).toBe(
    true,
  );
  expect(f.mount.textContent).toContain("System · restart recovery");
  f.recovery.expandedIds = new Set(["saved"]);
  f.paint(f.recovery);
  expect(f.mount.querySelector(".chat-notice")).not.toBeNull();
  expect(f.mount.textContent).not.toContain("PRIVATE_MODEL_CONTINUATION_PAYLOAD");
});

it("preserves long text, media inspection and copy without exposing reply or edit actions", () => {
  const f = fixture();
  const tail = "The complete prompt remains inspectable beyond the preview.";
  f.recovery.items = [
    {
      ...f.recovery.items[0]!,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Long prompt ".repeat(180) + tail },
          { type: "image", data: "cG5n", mimeType: "image/png", alt: "Saved image" },
        ],
      },
    },
  ];
  f.recovery.expandedIds = new Set(["saved"]);
  f.paint(f.recovery);
  const body = f.mount.querySelector(".chat-queue__recovery-detail")!;
  expect(body.textContent).toContain(tail);
  expect(body.querySelector(".chat-message-image")).not.toBeNull();
  expect(body.querySelector(".chat-copy-btn")).not.toBeNull();
  expect(body.querySelector(".chat-reply-btn,.chat-rewind-btn,.chat-queue__edit-input")).toBeNull();
  expect(f.recovery.onSend).not.toHaveBeenCalled();
});
