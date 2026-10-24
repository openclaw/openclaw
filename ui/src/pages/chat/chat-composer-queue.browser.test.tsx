import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderChatQueueSolid as ChatQueue } from "./components/chat-composer-queue.tsx";
import baseStyles from "../../styles/base.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";
import componentStyles from "../../styles/components.css?inline";

let container: HTMLDivElement;
let styles: HTMLStyleElement;

beforeEach(async () => {
  await page.viewport(960, 700);
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + queueStyles;
  document.head.append(styles);
  container = document.createElement("div");
  container.className = "agent-chat__composer-shell";
  container.style.cssText = "position:fixed;bottom:24px;left:24px;width:760px";
  document.body.append(container);
});

afterEach(() => {
  cleanupSolid();
  container.remove();
  styles.remove();
});

function drawQueue(editingId: string | null = null) {
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
  return {
    onEdit,
    row: container.querySelector<HTMLElement>('[data-chat-queue-item="first"]')!,
    trigger: container.querySelector<HTMLButtonElement>(".chat-queue__more")!,
  };
}

describe("queued message action menu", () => {
  it.each(["pointer", "keyboard"] as const)(
    "starts editing with textarea focus through %s selection",
    async (input) => {
      const { row, trigger, onEdit } = drawQueue();
      if (input === "pointer") {
        await page.elementLocator(trigger).click();
      } else {
        trigger.focus();
        await userEvent.keyboard("{ArrowDown}");
      }
      await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      const edit = row.querySelector<HTMLElement>('[role="menuitem"][data-value="edit"]')!;
      if (input === "pointer") {
        await page.elementLocator(edit).click();
      } else {
        expect(document.activeElement).toBe(edit);
        await userEvent.keyboard("{Enter}");
      }
      await waitForSolid(() => {
        expect(onEdit).toHaveBeenCalledExactlyOnceWith("first");
        const textarea = row.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")!;
        expect(textarea.value).toBe("First queued prompt");
        expect(document.activeElement).toBe(textarea);
        expect(row.hasAttribute("data-edit-keyboard-focus")).toBe(input === "keyboard");
      });
    },
  );

  it("cannot open or activate another row's menu while editing", async () => {
    const { row, trigger, onEdit } = drawQueue("second");
    await waitForSolid(() => expect(trigger.disabled).toBe(true));
    trigger.click();
    await waitForSolid(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(row.querySelector(":popover-open")).toBeNull();
      expect(onEdit).not.toHaveBeenCalled();
      expect(
        container.querySelector(".chat-queue__item--editing")?.getAttribute("data-chat-queue-item"),
      ).toBe("second");
    });
  });

  it("does not treat a double-click on the menu trigger as a row edit", async () => {
    const { trigger, onEdit } = drawQueue();
    await userEvent.dblClick(trigger);
    await waitForSolid(() => {
      expect(onEdit).not.toHaveBeenCalled();
      expect(container.querySelector(".chat-queue__edit-input")).toBeNull();
    });
  });
});
