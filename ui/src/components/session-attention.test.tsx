import { createMemo, createSignal, type Setter, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuestionPromptState } from "../app/question-prompt.ts";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createSessionAttention } from "./session-attention.ts";

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
});

function mountSnoozedSession(deadline: number) {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const context = createContext(
    createGateway(createTestGatewayClient(vi.fn().mockResolvedValue({ questions: [] }))),
    createSessions("main", []),
  );
  const host = document.body.appendChild(document.createElement("section"));
  let setDeadline!: Setter<number>;
  const view = mountSolid(
    () => {
      const [snoozedUntil, updateDeadline] = createSignal(deadline);
      setDeadline = updateDeadline;
      const attention = createSessionAttention(
        context,
        createQuestionPromptState(() => {}),
        host,
        () => true,
      );
      const visible = createMemo(() => {
        attention.resolve();
        const row = { snoozedUntil: snoozedUntil() };
        attention.scheduleSessionSnoozeWake([row]);
        return !isSessionSnoozed(row, Date.now());
      });
      return (
        <Show when={visible()}>
          <span>Resurfaced session</span>
        </Show>
      );
    },
    { container: host },
  );
  flush();
  return { ...view, setDeadline, host };
}

describe("session snooze deadline presentation", () => {
  it.each([
    { deadline: 200, clamped: false },
    { deadline: 2_147_483_847, clamped: true },
  ])("resurfaces a row at $deadline without polling", ({ deadline, clamped }) => {
    const view = mountSnoozedSession(deadline);
    if (clamped) {
      vi.advanceTimersByTime(2_147_483_647);
      flush();
      expect(view.queryByText("Resurfaced session")).toBeNull();
    }
    vi.advanceTimersByTime(100);
    flush();
    expect(view.queryByText("Resurfaced session")).toBeNull();
    vi.advanceTimersByTime(1);
    flush();
    expect(view.getByText("Resurfaced session")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    view.host.remove();
  });

  it("replaces the old deadline and retires pending work with its mounted view", () => {
    const view = mountSnoozedSession(200);
    view.setDeadline(300);
    flush();
    vi.advanceTimersByTime(101);
    flush();
    expect(view.queryByText("Resurfaced session")).toBeNull();
    view.unmount();
    view.host.remove();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(view.queryByText("Resurfaced session")).toBeNull();
  });
});
