import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChatTopbarNoticesContent } from "./chat-view-notices-content.tsx";
import "../../styles.css";

const warning =
  "Session worktree could not be restored. Free disk space if needed, check the source repository, then retry. The conversation and snapshot are preserved.";

it("presents persistent worktree failures with the shared toast and dismisses through the chat owner", async () => {
  const [error, setError] = createSignal<string | null>(warning);
  const dismiss = vi.fn(() => setError(null));
  const view = mountSolid(() => (
    <ChatTopbarNoticesContent error={error()} onDismissError={dismiss} />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-error.app-toast")).not.toBeNull(),
  );
  expect(view.container.querySelector(".chat-composer-neighbor-card")).toBeNull();
  expect(view.container.querySelector(".app-toast__message")?.textContent).toBe(
    "Session worktree could not be restored.",
  );
  expect(view.container.querySelector(".app-toast__description")?.textContent).toContain(
    "The conversation and snapshot are preserved.",
  );
  // The message already says everything, so there is nothing more to disclose.
  expect(view.container.querySelector("details")).toBeNull();
  view.container.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await waitForSolid(() => expect(view.container.querySelector(".chat-error")).toBeNull());
  expect(dismiss).toHaveBeenCalledOnce();
});

it("keeps diagnostic details redacted, open across refreshes, and reset for a different failure", async () => {
  const [onDismiss, setOnDismiss] = createSignal<(() => void) | undefined>();
  const [detail, setDetail] = createSignal("Restore failed\npassword=synthetic-secret");
  const view = mountSolid(() => (
    <ChatTopbarNoticesContent
      error="Could not restore the workspace."
      errorDetail={detail()}
      onDismissError={onDismiss()}
    />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-error.app-toast")).not.toBeNull(),
  );
  const details = view.container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).not.toContain("synthetic-secret");
  const diagnostic = details.querySelector<HTMLElement>(".lazy-view-error__detail")!;
  expect(getComputedStyle(diagnostic).whiteSpace).toBe("pre-wrap");
  expect(diagnostic.textContent).toContain("Restore failed\n");
  expect(diagnostic.tabIndex).toBe(0);
  expect(diagnostic.getAttribute("aria-label")).toBe("Error details");
  const summary = details.querySelector("summary")!;
  expect(getComputedStyle(summary).listStyleType).toBe("none");
  expect(summary.lastElementChild?.matches("svg.lazy-view-error__chevron")).toBe(true);
  expect(view.container.querySelector(".app-toast__dismiss")).toBeNull();
  details.open = true;
  await waitForSolid(() => {
    const well = details.querySelector<HTMLElement>(".lazy-view-error__well")!;
    const copy = well.querySelector<HTMLButtonElement>("button")!;
    const block = well.getBoundingClientRect();
    const text = diagnostic.getBoundingClientRect();
    const button = copy.getBoundingClientRect();
    expect(button.left).toBeGreaterThanOrEqual(text.right);
    expect(button.top).toBeCloseTo(text.top, 0);
    expect(button.right).toBeLessThanOrEqual(block.right);
    expect(getComputedStyle(well).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Number.parseFloat(getComputedStyle(well).borderRadius)).toBeGreaterThan(0);
  });
  setOnDismiss(() => vi.fn());
  await waitForSolid(() =>
    expect(view.container.querySelector(".app-toast__dismiss")).not.toBeNull(),
  );
  await waitForSolid(() => expect(view.container.querySelector("details")).toBe(details));
  expect(details.open).toBe(true);
  setDetail("A different restore failure");
  await waitForSolid(() => expect(view.container.querySelector("details")?.open).toBe(false));
});
