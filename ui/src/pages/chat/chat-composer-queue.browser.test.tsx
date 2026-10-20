import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderChatQueueSolid as ChatQueue } from "./components/chat-composer-queue.tsx";
import baseStyles from "../../styles/base.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";

async function drawQueue(editingId: string | null = null) {
  await page.viewport(960, 700);
  const styles = document.head.appendChild(document.createElement("style"));
  styles.textContent = baseStyles + queueStyles;
  const container = document.body.appendChild(document.createElement("div"));
  container.className = "agent-chat__composer-shell";
  container.style.cssText = "position:fixed;bottom:24px;left:24px;width:760px";
  onTestFinished(() => {
    container.remove();
    styles.remove();
  });
  const [editing, setEditing] = createSignal(editingId);
  const onEdit = vi.fn((id: string) => setEditing(id));
  mountSolid(
    () => (
      <ChatQueue
        queue={[
          { id: "first", text: "First queued prompt", createdAt: 1, sendState: "waiting-idle" },
          { id: "second", text: "Second queued prompt", createdAt: 2, sendState: "waiting-idle" },
        ]}
        queuedEdit={{ editingId: editing(), onEdit, onCancel: () => setEditing(null) }}
        onQueueRemove={vi.fn()}
      />
    ),
    { container },
  );
  flush();
  const row = container.querySelector<HTMLElement>('[data-chat-queue-item="first"]')!;
  const q = <T extends HTMLElement = HTMLElement>(selector: string): T =>
    row.querySelector<T>(selector)!;
  return { container, onEdit, q, row, trigger: q<HTMLButtonElement>(".chat-queue__more") };
}

it.each(["pointer", "keyboard"] as const)(
  "focuses the editor after %s selection",
  async (input) => {
    const { q, row, trigger, onEdit } = await drawQueue();
    if (input === "pointer") {
      await page.elementLocator(trigger).click();
    } else {
      trigger.focus();
      await userEvent.keyboard("{ArrowDown}");
    }
    await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    const edit = q('[role="menuitem"][data-value="edit"]');
    if (input === "pointer") {
      await page.elementLocator(edit).click();
    } else {
      expect(document.activeElement).toBe(edit);
      await userEvent.keyboard("{Enter}");
    }
    await waitForSolid(() => {
      expect(onEdit).toHaveBeenCalledExactlyOnceWith("first");
      const textarea = q<HTMLTextAreaElement>(".chat-queue__edit-input");
      expect(textarea.value).toBe("First queued prompt");
      expect(document.activeElement).toBe(textarea);
      expect(row.hasAttribute("data-edit-keyboard-focus")).toBe(input === "keyboard");
    });
  },
);

it("locks other menus while a row is being edited", async () => {
  const { container, q, trigger, onEdit } = await drawQueue("second");
  await waitForSolid(() => expect(trigger.disabled).toBe(true));
  trigger.click();
  await waitForSolid(() => {
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(q(":popover-open")).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-queue__item--editing")).toMatchObject({
      dataset: { chatQueueItem: "second" },
    });
  });
});

it("does not edit on a double-click of the menu trigger", async () => {
  const { q, trigger, onEdit } = await drawQueue();
  await userEvent.dblClick(trigger);
  await waitForSolid(() => {
    expect(onEdit).not.toHaveBeenCalled();
    expect(q(".chat-queue__edit-input")).toBeNull();
  });
});
