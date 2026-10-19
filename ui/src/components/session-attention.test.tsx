import { createMemo, createSignal, type Setter, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuestionPromptState } from "../app/question-prompt.ts";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createSessionAttention } from "./session-attention.ts";

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes questions only for a changed client and retires the Gateway subscription", async () => {
  const firstRequest = vi.fn().mockResolvedValue({ questions: [] });
  const secondRequest = vi.fn().mockResolvedValue({ questions: [] });
  const thirdRequest = vi.fn().mockResolvedValue({ questions: [] });
  const gateway = createGatewayHarness(createTestGatewayClient(firstRequest));
  gateway.publish({ hello: gatewayHelloForMethods(["question.list"]) });
  const context = createContext(gateway.gateway, createSessions("main", []));
  const host = document.body.appendChild(document.createElement("section"));
  const view = mountSolid(
    () => {
      const attention = createSessionAttention(
        context,
        createQuestionPromptState(() => {}),
        host,
        () => true,
      );
      return <span>{attention.resolve()({ key: "agent:main:main" }).kind}</span>;
    },
    { container: host },
  );
  try {
    await waitForSolid(() => expect(firstRequest).toHaveBeenCalledTimes(1));
    gateway.publish({ lastError: "Synthetic unrelated notification" });
    flush();
    expect(firstRequest).toHaveBeenCalledTimes(1);
    gateway.publish({ client: createTestGatewayClient(secondRequest), lastError: null });
    await waitForSolid(() => expect(secondRequest).toHaveBeenCalledTimes(1));
    expect(firstRequest).toHaveBeenCalledTimes(1);
    view.unmount();
    gateway.publish({ client: createTestGatewayClient(thirdRequest) });
    flush();
    expect(thirdRequest).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    host.remove();
  }
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
  let refresh!: () => void;
  const view = mountSolid(
    () => {
      const [snoozedUntil, updateDeadline] = createSignal(deadline);
      setDeadline = updateDeadline;
      const [revision, setRevision] = createSignal(0);
      refresh = () => setRevision((value) => value + 1);
      const attention = createSessionAttention(
        context,
        createQuestionPromptState(() => {}),
        host,
        () => true,
      );
      const visible = createMemo(() => {
        revision();
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
  return { ...view, setDeadline, refresh, host };
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

  it("keeps the earliest wake armed across unrelated session events", () => {
    const view = mountSnoozedSession(200);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const schedule = vi.spyOn(globalThis, "setTimeout");
    for (let index = 0; index < 24; index += 1) {
      view.refresh();
      flush();
    }
    expect(clear).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(101);
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
