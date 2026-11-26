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

it.each([300, 500, 1280])(
  "keeps full reply text ellipsized beside reachable recovery at %ipx",
  async (width) => {
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, previous.height);
    const refresh = vi.fn();
    const dismiss = vi.fn();
    const diagnostic =
      "The model provider interrupted the connection before the reply finished. The example gateway returned upstream status 502.\nRequest ID: example-7942.";
    try {
      const view = mountSolid(() => (
        <ChatComposerNoticesContent
          sessionKey="agent:main:main"
          connected
          messages={[]}
          runError={{ runId: "synthetic-run", summary: diagnostic }}
          onRefresh={refresh}
          onDismissRunError={dismiss}
        />
      ));
      await waitForSolid(() =>
        expect(view.container.querySelector(".chat-error__refresh")).not.toBeNull(),
      );
      const notice = view.container.querySelector<HTMLElement>(".chat-error.chat-error--reply")!;
      const message = notice.querySelector<HTMLElement>(".app-toast__message")!;
      expect(notice.classList.contains("app-toast")).toBe(false);
      expect(message.textContent).toBe(diagnostic);
      expect(message.getAttribute("role")).toBe("alert");
      expect(
        notice.querySelector(
          "details, summary, [aria-expanded], .lazy-view-error__chevron, .report-issue-link",
        ),
      ).toBeNull();
      const style = getComputedStyle(message);
      expect([style.whiteSpace, style.overflowX, style.textOverflow]).toEqual([
        "nowrap",
        "hidden",
        "ellipsis",
      ]);
      expect(message.getBoundingClientRect().height).toBeLessThanOrEqual(
        Number.parseFloat(style.lineHeight) + 1,
      );
      if (width === 300) {
        expect(message.scrollWidth).toBeGreaterThan(message.clientWidth);
      }
      const recovery = notice.querySelector<HTMLButtonElement>(".chat-error__refresh")!;
      const close = notice.querySelector<HTMLButtonElement>(
        ".chat-error__dismiss.app-toast__dismiss",
      )!;
      const bounds = [message, recovery, close].map((node) => node.getBoundingClientRect());
      const centers = bounds.map((rect) => rect.y + rect.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      expect(bounds[0]!.right).toBeLessThanOrEqual(bounds[1]!.left);
      expect(bounds[1]!.right).toBeLessThanOrEqual(bounds[2]!.left);
      expect(bounds[2]!.right).toBeLessThanOrEqual(notice.getBoundingClientRect().right);
      expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
      expect(getComputedStyle(close).opacity).toBe("1");
      for (const target of [recovery, close]) {
        const rect = target.getBoundingClientRect();
        expect(
          target.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          ),
        ).toBe(true);
        target.click();
      }
      expect(refresh).toHaveBeenCalledOnce();
      expect(dismiss).toHaveBeenCalledOnce();
    } finally {
      await page.viewport(previous.width, previous.height);
    }
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
