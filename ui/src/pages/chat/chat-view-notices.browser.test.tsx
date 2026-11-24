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
import "../../styles/chat/conversation-notices.css";
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

const longError =
  "Restore failed because the provider reported that the lease was destroyed before the reply finished.\n" +
  "diagnostic ".repeat(40).trim();

async function atWidth(width: number, run: () => Promise<void>) {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, previous.height);
  try {
    await run();
  } finally {
    await page.viewport(previous.width, previous.height);
  }
}

it("shows a short reply error whole, with no control to open it", async () => {
  await atWidth(820, async () => {
    const dismiss = vi.fn();
    const view = mountSolid(() => (
      <ChatComposerNoticesContent
        connected
        messages={[]}
        runError={{ runId: "run-1", summary: "Error: Restore failed." }}
        onRefresh={() => {}}
        onDismissRunError={dismiss}
      />
    ));
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-error__refresh")).not.toBeNull(),
    );
    const message = view.getByRole("alert");
    const chevron = view.container.querySelector<HTMLButtonElement>(".chat-reply-notice__chevron")!;
    expect(message.scrollWidth).toBeLessThanOrEqual(message.clientWidth);
    expect(chevron).toMatchObject({ disabled: true });
    expect(getComputedStyle(chevron).visibility).toBe("hidden");
    const height = message.getBoundingClientRect().height;
    message.click();
    await waitForSolid(() => expect(message.getBoundingClientRect().height).toBe(height));
    const recovery = box(view.container, ".chat-error__refresh");
    expect(recovery.left).toBeGreaterThanOrEqual(message.getBoundingClientRect().right);
    view.getByRole("button", { name: "Dismiss error", exact: true }).click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

it.each([820, 400, 300])(
  "keeps a long reply error on one line and opens it in place at %ipx",
  async (width) => {
    await atWidth(width, async () => {
      const onRefresh = vi.fn();
      const [summary, setSummary] = createSignal(longError);
      const view = mountSolid(() => (
        <ChatComposerNoticesContent
          connected
          messages={[]}
          runError={{ runId: "run-1", summary: summary() }}
          onRefresh={onRefresh}
        />
      ));
      const chevron = () =>
        view.container.querySelector<HTMLButtonElement>(".chat-reply-notice__chevron")!;
      await waitForSolid(() => expect(chevron()).toMatchObject({ disabled: false }));
      const notice = view.container.querySelector<HTMLElement>(".chat-reply-notice")!;
      const message = view.getByRole("alert");
      const recovery = view.getByRole("button", { name: "Refresh", exact: true });
      const closed = message.getBoundingClientRect().height;
      const actionsTop = recovery.getBoundingClientRect().top;
      expect(closed).toBeLessThanOrEqual(32);
      expect(message.scrollWidth).toBeGreaterThan(message.clientWidth);
      expect(message.textContent).toBe(longError);
      expect(recovery.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        message.getBoundingClientRect().right,
      );

      message.click();
      await waitForSolid(() => expect(chevron().getAttribute("aria-expanded")).toBe("true"));
      expect(message.getBoundingClientRect().height).toBeGreaterThan(closed * 2);
      expect(message.scrollWidth).toBeLessThanOrEqual(message.clientWidth);
      expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
      // Opened text uses the width under the actions instead of a narrow column.
      expect(message.getBoundingClientRect().right).toBeGreaterThan(
        recovery.getBoundingClientRect().left,
      );
      expect(recovery.getBoundingClientRect().top).toBe(actionsTop);
      const bounds = recovery.getBoundingClientRect();
      expect(
        recovery.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
        ),
      ).toBe(true);
      recovery.click();
      expect(onRefresh).toHaveBeenCalledOnce();

      // Selecting the error to copy it leaves it open.
      getSelection()!.selectAllChildren(message);
      message.click();
      await waitForSolid(() => expect(chevron().getAttribute("aria-expanded")).toBe("true"));
      getSelection()!.removeAllRanges();
      chevron().click();
      await waitForSolid(() => expect(message.getBoundingClientRect().height).toBe(closed));

      message.click();
      await waitForSolid(() => expect(chevron().getAttribute("aria-expanded")).toBe("true"));
      setSummary("A different failure. " + longError);
      await waitForSolid(() => {
        expect(chevron().getAttribute("aria-expanded")).toBe("false");
        expect(message.getBoundingClientRect().height).toBe(closed);
      });
      setSummary("Short failure.");
      await waitForSolid(() => expect(chevron()).toMatchObject({ disabled: true }));
    });
  },
);

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
