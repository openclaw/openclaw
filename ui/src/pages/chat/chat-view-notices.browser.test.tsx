import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  ChatComposerNoticesContent,
  ChatPlacementStartupNotice,
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
    const touch = { identifier: 1, target: diagnostic, clientX: 100, clientY };
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
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

it.each([300, 500])("keeps recovery and reporting clickable at %ipx", async (width) => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, previous.height);
  try {
    const view = mountSolid(() => (
      <ChatComposerNoticesContent
        sessionKey="agent:main:main"
        connected
        messages={[]}
        runError={{
          runId: "synthetic-run",
          summary: "Error: Restore failed.\nprovider reported lease destroyed",
        }}
        onRefresh={() => {}}
      />
    ));
    await waitForSolid(() => {
      const recovery = view.container.querySelector<HTMLElement>(".chat-error__refresh")!;
      const report = view.container.querySelector<HTMLAnchorElement>("a.report-issue-link")!;
      const a = recovery.getBoundingClientRect(),
        b = report.getBoundingClientRect();
      expect(a.width).toBeGreaterThan(0);
      expect(b.width).toBeGreaterThan(0);
      expect(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).toBe(
        false,
      );
      for (const target of [recovery, report]) {
        const bounds = target.getBoundingClientRect();
        expect(
          target.contains(
            document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
          ),
        ).toBe(true);
      }
    });
  } finally {
    await page.viewport(previous.width, previous.height);
  }
});

it("keeps discard recovery below the full warning on mobile", async () => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(300, previous.height);
  const discard = vi.fn();
  try {
    const view = mountSolid(() => (
      <ChatPlacementStartupNotice
        messages={[]}
        connected
        status={{
          sessionKey: "agent:main:main",
          phase: "failed",
          startedAt: 1,
          error: "Recovery needs a reload. Unsaved starts will be lost.",
          discardAndReload: discard,
        }}
      />
    ));
    await waitForSolid(() => {
      const action = view.container.querySelector<HTMLElement>(".chat-error__discard")!;
      const message = view.container.querySelector<HTMLElement>(".app-toast__message")!;
      expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        message.getBoundingClientRect().bottom,
      );
      expect(message.getBoundingClientRect().width).toBeGreaterThan(200);
    });
    view.container.querySelector<HTMLButtonElement>(".chat-error__discard")!.click();
    expect(discard).toHaveBeenCalledOnce();
  } finally {
    await page.viewport(previous.width, previous.height);
  }
});
