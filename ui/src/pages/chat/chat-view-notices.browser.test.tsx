import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  ChatComposerNoticesContent,
  ChatTopbarNoticesContent,
} from "./chat-view-notices-content.tsx";
import "../../styles.css";
import "../../styles/chat/layout.css";

const box = (root: Element, selector: string) =>
  root.querySelector(selector)!.getBoundingClientRect();

it("renders a self-contained worktree warning as a dismissible shared toast", async () => {
  const [error, setError] = createSignal<string | null>(
    "Session worktree could not be restored. Free disk space if needed, check the source repository, then retry.",
  );
  const dismiss = vi.fn(() => setError(null));
  const view = mountSolid(() => (
    <ChatTopbarNoticesContent error={error()} onDismissError={dismiss} />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-error.app-toast")).not.toBeNull(),
  );
  expect(view.container.querySelector(".app-toast__message")?.textContent).toBe(
    "Session worktree could not be restored.",
  );
  expect(view.container.querySelector("details")).toBeNull();
  view.container.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await waitForSolid(() => expect(view.container.querySelector(".chat-error")).toBeNull());
  expect(dismiss).toHaveBeenCalledOnce();
});

it("keeps redacted diagnostics readable, stable across refreshes, and reset for a new failure", async () => {
  const [detail, setDetail] = createSignal(
    "Restore failed\npassword=synthetic-secret\n" + "Diagnostic line\n".repeat(80),
  );
  const [onDismiss, setOnDismiss] = createSignal<(() => void) | undefined>();
  const view = mountSolid(() => (
    <ChatTopbarNoticesContent
      error="Could not restore."
      errorDetail={detail()}
      onDismissError={onDismiss()}
    />
  ));
  await waitForSolid(() => expect(view.container.querySelector("details")).not.toBeNull());
  const details = view.container.querySelector("details")!;
  const diagnostic = details.querySelector<HTMLElement>(".lazy-view-error__detail")!;
  expect([details.open, details.textContent?.includes("synthetic-secret")]).toEqual([false, false]);
  expect([getComputedStyle(diagnostic).whiteSpace, diagnostic.tabIndex]).toEqual(["pre-wrap", 0]);
  details.open = true;
  const copy = box(details, ".lazy-view-error__action");
  expect(copy.left).toBeGreaterThanOrEqual(diagnostic.getBoundingClientRect().right);
  expect(copy.right).toBeLessThanOrEqual(box(details, ".lazy-view-error__well").right);
  const dismiss = vi.fn();
  setOnDismiss(() => dismiss);
  await waitForSolid(() =>
    expect(view.container.querySelector(".app-toast__dismiss")).not.toBeNull(),
  );
  expect(view.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(diagnostic.scrollHeight).toBeGreaterThan(diagnostic.clientHeight);
  for (const [type, clientY] of [
    ["touchstart", 200],
    ["touchmove", 120],
    ["touchend", 120],
  ] as const) {
    const touch = new Touch({ identifier: 1, target: diagnostic, clientX: 100, clientY });
    const event = new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === "touchend" ? [] : [touch],
      changedTouches: [touch],
    });
    diagnostic.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(dismiss).not.toHaveBeenCalled();
  expect(details.open).toBe(true);
  setDetail("A different restore failure");
  await waitForSolid(() => expect(view.container.querySelector("details")?.open).toBe(false));
});

it("keeps the recovery action beside the title with a visible dismiss", async () => {
  const dismiss = vi.fn();
  const view = mountSolid(() => (
    <ChatComposerNoticesContent
      sessionKey="agent:main:main"
      connected
      messages={[]}
      runError={{
        runId: "run-1",
        summary: "Error: Restore failed.\nprovider reported lease destroyed",
      }}
      onRefresh={() => {}}
      onDismissRunError={dismiss}
    />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-error__refresh")).not.toBeNull(),
  );
  const offset = () =>
    box(view.container, ".chat-error__refresh").top -
    box(view.container, ".app-toast__message").top;
  const closed = offset();
  expect(Math.abs(closed)).toBeLessThan(8);
  view.container.querySelector("details")!.open = true;
  await waitForSolid(() => expect(offset()).toBe(closed));
  const close = view.container.querySelector<HTMLButtonElement>(".app-toast__dismiss")!;
  expect(getComputedStyle(close).opacity).toBe("1");
  close.click();
  expect(dismiss).toHaveBeenCalledOnce();
});
