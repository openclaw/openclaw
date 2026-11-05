import { createSignal, type ComponentProps } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildPendingInputQueueItems } from "./chat-pending-inputs.ts";
import { renderChatQueueSolid as ChatQueue } from "./components/chat-composer-queue.tsx";
import "../../test-helpers/load-styles.ts";

function drawQueue(
  editingId: string | null = null,
  overrides: Partial<ComponentProps<typeof ChatQueue>> = {},
) {
  const [editing, setEditing] = createSignal(editingId);
  const onEdit = vi.fn((id: string) => setEditing(id));
  const { container } = mountSolid(() => (
    <ChatQueue
      queue={[
        { id: "first", text: "First queued prompt", createdAt: 1, sendState: "waiting-idle" },
        { id: "second", text: "Second queued prompt", createdAt: 2, sendState: "waiting-idle" },
      ]}
      {...overrides}
      queuedEdit={{ editingId: editing(), onEdit, onCancel: () => setEditing(null) }}
      onQueueRemove={vi.fn()}
    />
  ));
  flush();
  return {
    container,
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
      await expect.element(page.elementLocator(trigger)).toHaveAttribute("aria-expanded", "true");
      const edit = row.querySelector<HTMLElement>('[role="menuitem"][data-value="edit"]')!;
      if (input === "pointer") {
        await page.elementLocator(edit).click();
      } else {
        expect(document.activeElement).toBe(edit);
        await userEvent.keyboard("{Enter}");
      }
      await expect.element(page.getByRole("textbox")).toHaveValue("First queued prompt");
      await expect.element(page.getByRole("textbox")).toHaveFocus();
      expect(onEdit).toHaveBeenCalledExactlyOnceWith("first");
      expect(row.hasAttribute("data-edit-keyboard-focus")).toBe(input === "keyboard");
    },
  );

  it("cannot open or activate another row's menu while editing", async () => {
    const { container, trigger, onEdit } = drawQueue("second");
    await expect.element(page.elementLocator(trigger)).toBeDisabled();
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onEdit).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-queue__item--editing")).toHaveAttribute(
      "data-chat-queue-item",
      "second",
    );
  });

  it("does not treat a double-click on the menu trigger as a row edit", async () => {
    const { container, trigger, onEdit } = drawQueue();
    await userEvent.dblClick(trigger);
    expect(onEdit).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-queue__edit-input")).toBeNull();
  });
});

it.each([1, 2].flatMap((count) => [false, true].map((server) => ({ count, server }))))(
  "shows $count annotations (server=$server)",
  ({ count, server }) => {
    const attachments = Array.from({ length: count }, (_, id) => ({
      id: String(id),
      fileName: "selection-comment.txt",
      mimeType: "text/plain",
      selectionAnnotation: { text: "x", comment: "Note", sessionKey: "main", start: 0, end: 1 },
    }));
    // Display projection can retain labels without fetchable URLs.
    const media = attachments.map(({ fileName }) => ({ fileName }));
    const message = { role: "user", content: " \n\t", __openclaw: { media } };
    const { container } = drawQueue(null, {
      queue: [{ id: "annotations", text: " \n\t", createdAt: 1, attachments }],
      displayQueue: server
        ? buildPendingInputQueueItems([
            { id: "input", runId: "run", state: "queued", queued: true, acceptedAt: 1, message },
          ])
        : undefined,
    });
    expect(container.querySelector(".chat-queue__text")?.textContent).toBe(
      count === 1 ? "1 annotation" : "2 annotations",
    );
  },
);
