import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, type Setter } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createQuestionPromptState } from "../app/question-prompt.ts";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import * as sidebar from "../test-helpers/app-sidebar.ts";
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

function mountAttention(
  render: (attention: ReturnType<typeof createSessionAttention>) => JSX.Element,
  gateway = sidebar.createGateway(
    createTestGatewayClient(vi.fn().mockResolvedValue({ questions: [] })),
  ),
) {
  const context = sidebar.createContext(gateway, sidebar.createSessions("main", []));
  const host = document.body.appendChild(document.createElement("section"));
  const questions = createQuestionPromptState(() => {});
  const view = mountSolid(
    () => render(createSessionAttention(context, questions, host, () => true)),
    { container: host },
  );
  onTestFinished(() => host.remove());
  return view;
}
function advance(milliseconds: number) {
  vi.advanceTimersByTime(milliseconds);
  flush();
}

it("refreshes questions only for a changed client and retires the Gateway subscription", async () => {
  const firstRequest = vi.fn().mockResolvedValue({ questions: [] });
  const secondRequest = vi.fn().mockResolvedValue({ questions: [] });
  const thirdRequest = vi.fn().mockResolvedValue({ questions: [] });
  const gateway = sidebar.createGatewayHarness(createTestGatewayClient(firstRequest));
  gateway.publish({ hello: gatewayHelloForMethods(["question.list"]) });
  const view = mountAttention(
    (attention) => <span>{attention.resolve()({ key: "agent:main:main" }).kind}</span>,
    gateway.gateway,
  );
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
});

function mountSnoozedSession(deadline: number) {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  let updateRow!: Setter<{ snoozedUntil: number }>;
  const view = mountAttention((attention) => {
    const [row, setRow] = createSignal({ snoozedUntil: deadline });
    updateRow = setRow;
    const visible = createMemo(() => {
      attention.resolve();
      attention.scheduleSessionSnoozeWake([row()]);
      return !isSessionSnoozed(row(), Date.now());
    });
    return <>{visible() && <span>Resurfaced session</span>}</>;
  });
  flush();
  return {
    ...view,
    setDeadline: (snoozedUntil: number) => updateRow({ snoozedUntil }),
    refresh: () => updateRow((row) => ({ ...row })),
  };
}

it.each([200, 2_147_483_847])("keeps the wake at %d armed across unrelated events", (deadline) => {
  const view = mountSnoozedSession(deadline);
  for (let index = 0; index < 24; index += 1) {
    view.refresh();
    flush();
  }
  if (deadline > 2_147_483_647) {
    advance(2_147_483_647);
    expect(view.queryByText("Resurfaced session")).toBeNull();
  }
  advance(100);
  expect(view.queryByText("Resurfaced session")).toBeNull();
  advance(1);
  expect(view.getByText("Resurfaced session")).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces the old deadline and retires pending work with its mounted view", () => {
  const view = mountSnoozedSession(200);
  view.setDeadline(300);
  flush();
  advance(101);
  expect(view.queryByText("Resurfaced session")).toBeNull();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(200);
  expect(view.queryByText("Resurfaced session")).toBeNull();
});
