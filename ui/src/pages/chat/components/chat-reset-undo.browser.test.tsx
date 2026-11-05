import { createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatBoardResetConfirmation } from "../chat-board-reset-confirmation.tsx";
import { buildResetDividerItem } from "../chat-progress.ts";
import { ChatDivider } from "./chat-divider.tsx";

it("opens reset Undo confirmation and lets the user cancel before confirming", async () => {
  const undo = vi.fn();
  const [pendingBoundary, setPendingBoundary] = createSignal<string>();
  const divider = buildResetDividerItem(
    { kind: "reset", id: "reset-marker", boundaryId: "reset-entry" },
    1_000,
    0,
  );
  const view = mountSolid(() => (
    <>
      <ChatDivider item={divider} onUndoReset={setPendingBoundary} />
      <Show when={pendingBoundary()}>
        <ChatBoardResetConfirmation
          undoReset
          onResolve={(confirmed) => {
            if (confirmed) {
              undo(pendingBoundary());
            }
            setPendingBoundary(undefined);
          }}
        />
      </Show>
    </>
  ));
  try {
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.element(page.getByRole("dialog", { name: "Undo session reset?" })).toBeVisible();
    await expect
      .element(
        page.getByText("Messages sent after the reset stay in another branch", { exact: false }),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(undo).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Undo reset", exact: true }).click();
    expect(undo).toHaveBeenCalledExactlyOnceWith("reset-entry");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    view.unmount();
  }
});
