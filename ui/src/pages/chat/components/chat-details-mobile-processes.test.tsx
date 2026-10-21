/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  ChatDetailsMobileProcesses,
  type ChatDetailsMobileProcessesProps,
} from "./chat-details-mobile-processes.tsx";

it("shows two prioritized processes and opens the full collection without mutating source order", () => {
  const row = (id: string, status: SessionProcessSummary["status"]): SessionProcessSummary => ({
    processId: id,
    instanceId: id,
    name: id,
    status,
    startedAt: 1,
    endedAt: 2,
    tail: "first line\nlatest output\n",
    truncated: false,
    canStop: false,
  });
  const source = [
    row("completed", "completed"),
    row("failed", "failed"),
    row("running", "running"),
  ];
  const refresh = vi.fn(async () => {});
  const [data, setData] = createSignal<ChatDetailsMobileProcessesProps["data"]>({
    rows: source,
    error: null,
    loading: false,
    refresh,
  });
  const [presented, setPresented] = createSignal(true);
  const onOpen = vi.fn();
  const view = mountSolid(() => (
    <ChatDetailsMobileProcesses data={data()} presented={presented()} onOpen={onOpen} />
  ));
  expect(
    [...view.container.querySelectorAll('[role="listitem"]')].map((item) =>
      item.getAttribute("data-process-id"),
    ),
  ).toEqual(["running", "failed"]);
  expect(source.map((item) => item.processId)).toEqual(["completed", "failed", "running"]);
  expect(
    [...view.container.querySelectorAll(".chat-details__process-elapsed")].map((timer) =>
      timer.textContent?.trim(),
    ),
  ).toEqual(["1s", "1s"]);
  const running = view.getByRole("button", { name: "running. Running. latest output" });
  expect(running.getAttribute("title")).toBeNull();
  running.click();
  view.getByRole("button", { name: "Show all" }).click();
  expect(onOpen).toHaveBeenCalledTimes(2);
  setPresented(false);
  flush();
  running.click();
  view.getByRole("button", { name: "Show all" }).click();
  expect(onOpen).toHaveBeenCalledTimes(2);
  setData({ rows: [], error: "Unavailable", loading: false, refresh });
  setPresented(true);
  flush();
  view.getByRole("button", { name: "Retry" }).click();
  expect(refresh).toHaveBeenCalledOnce();
});
