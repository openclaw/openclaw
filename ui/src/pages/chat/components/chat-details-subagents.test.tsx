/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsSubagents, type ChatDetailsSubagentsProps } from "./chat-details-subagents.tsx";

type Row = ChatDetailsSubagentsProps["rows"][number];

function mountSubagents(initial: readonly Row[], mobile = false) {
  const [rows, setRows] = createSignal(initial);
  const [collapsed, setCollapsed] = createSignal(false);
  const openChild = vi.fn();
  const openCollection = vi.fn();
  const view = mountSolid(() => (
    <ChatDetailsSubagents
      rows={rows()}
      mobile={mobile}
      collapsed={collapsed()}
      workingLabel="Working"
      onOpenSubagent={openChild}
      onOpenSubagents={openCollection}
    />
  ));
  return { view, setRows, setCollapsed, openChild, openCollection };
}

it.each([false, true])("shimmers only working names as status changes (mobile=%s)", (mobile) => {
  const { view, setRows } = mountSubagents(
    [{ key: "child", label: "Review", status: "running" }],
    mobile,
  );
  const name = () => view.container.querySelector(".chat-details-subagents__name")!;
  expect(name().classList.contains("text-shimmer")).toBe(true);
  for (const status of ["waiting", "queued", "done", "failed", "stopped", "running"] as const) {
    setRows([{ key: "child", label: "Review", status }]);
    flush();
    expect(name().textContent).toBe("Review");
    expect(name().classList.contains("text-shimmer")).toBe(
      status === "running" || status === "waiting",
    );
  }
});

it.each([
  { mobile: false, limit: 5 },
  { mobile: true, limit: 3 },
])(
  "uses the total at the $limit-item boundary (mobile=$mobile), preserving child and collection intent",
  ({ mobile, limit }) => {
    const initial: Row[] = Array.from({ length: limit }, (_, index) => ({
      key: `child-${index}`,
      label: "Review",
      status: index === 1 ? "running" : "done",
      session: { startedAt: Date.now() - 3000 },
    }));
    const { view, setRows, openChild, openCollection } = mountSubagents(initial, mobile);
    const buttons = view.getAllByRole("button");
    expect(buttons).toHaveLength(limit);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Review Working");
    expect(buttons[0]!.querySelector(".chat-details-subagents__status")?.classList).toContain(
      "sr-only",
    );
    expect(buttons[0]!.querySelector(".chat-details-subagents__spinner")).not.toBeNull();
    expect(buttons[0]!.querySelector("openclaw-elapsed-time")?.textContent).toBeTruthy();
    buttons[0]!.click();
    expect(openChild).toHaveBeenLastCalledWith("child-1");
    buttons[1]!.click();
    expect(openChild).toHaveBeenLastCalledWith("child-0");

    setRows([...initial, { key: "last-child", label: "Review", status: "done" }]);
    flush();
    expect(view.getAllByRole("button")).toHaveLength(1);
    view
      .getByRole("button", { name: new RegExp(`All subagents.*1 Working.*${limit} Done`) })
      .click();
    expect(openCollection).toHaveBeenCalledExactlyOnceWith();

    setRows((previous) => previous.map(({ key, label }) => ({ key, label, status: "done" })));
    flush();
    expect(view.getAllByRole("button")).toHaveLength(1);
    view.getByRole("button", { name: `All subagents. ${limit + 1} Done` }).click();
    expect([openCollection, openChild].map((fn) => fn.mock.calls.length)).toEqual([2, 2]);
  },
);

it("omits empty content and removes collapsed activity when the last waiting child settles", () => {
  const { view, setRows, setCollapsed } = mountSubagents([]);
  expect(view.container.childElementCount).toBe(0);
  setCollapsed(true);
  setRows([{ key: "waiting-child", label: "Waiting child", status: "waiting" }]);
  flush();
  expect(view.getByRole("img", { name: "1 subagent running" })).toBeTruthy();
  expect([view.queryByRole("button"), view.container.textContent]).toEqual([null, ""]);
  setRows([{ key: "waiting-child", label: "Waiting child", status: "done" }]);
  flush();
  expect(view.container.childElementCount).toBe(0);
  setCollapsed(false);
  flush();
  expect(view.getByRole("button", { name: "Waiting child Done" })).toBeTruthy();
});

it("summarizes at most two statuses and never shows Stopped", () => {
  const working = (key: string): Row => ({ key, label: key, status: "running" });
  const waiting = (key: string): Row => ({ key, label: key, status: "waiting" });
  const queued = (key: string): Row => ({ key, label: key, status: "queued" });
  const done = (key: string): Row => ({ key, label: key, status: "done" });
  const stopped = (key: string): Row => ({ key, label: key, status: "stopped" });
  const summary = () =>
    [...view.container.querySelectorAll(".chat-details-subagents__count")].map(
      (count) => count.textContent,
    );
  const { view, setRows } = mountSubagents([
    working("a"),
    waiting("b"),
    queued("c"),
    done("d"),
    stopped("e"),
    working("f"),
  ]);
  expect(summary()).toEqual(["3 Working", "1 Queued"]);
  setRows([working("a"), waiting("b"), done("d"), stopped("e"), done("f"), working("g")]);
  flush();
  expect(summary()).toEqual(["3 Working", "3 Done"]);
  setRows([done("a"), stopped("b"), done("c"), done("d"), done("e"), done("f")]);
  flush();
  expect(summary()).toEqual(["6 Done"]);
  setRows(["a", "b", "c", "d", "e", "f"].map(stopped));
  flush();
  expect(summary()).toEqual(["6 Done"]);
});

it("folds failed runs into Done without changing child outcomes", () => {
  const initial: Row[] = [
    { key: "a", label: "A", status: "running" },
    { key: "b", label: "B", status: "waiting" },
    { key: "c", label: "C", status: "queued" },
    { key: "d", label: "D", status: "done" },
    { key: "e", label: "E", status: "failed" },
    { key: "f", label: "F", status: "stopped" },
  ];
  const { view, setRows, openChild } = mountSubagents(initial);
  view.getByRole("button", {
    name: "All subagents. 2 Working, 1 Queued",
  });
  const shimmering = view.container.querySelectorAll(".chat-details-subagents__count.text-shimmer");
  expect([...shimmering].map((count) => count.getAttribute("data-status"))).toEqual(["running"]);
  setRows([initial[4]!]);
  flush();
  view.getByRole("button", { name: "E Failed" }).click();
  expect(openChild).toHaveBeenCalledExactlyOnceWith("e");
});

it("mutes finished list rows while working and queued rows keep full emphasis", () => {
  const { view, setRows } = mountSubagents([
    { key: "a", label: "A", status: "running" },
    { key: "b", label: "B", status: "waiting" },
    { key: "c", label: "C", status: "queued" },
    { key: "d", label: "D", status: "done" },
    { key: "e", label: "E", status: "failed" },
  ]);
  const muted = () =>
    [...view.container.querySelectorAll(".chat-details-subagents__row--finished")].map((row) =>
      row.getAttribute("data-subagent-session-key"),
    );
  expect(muted()).toEqual(["d", "e"]);
  setRows([
    { key: "a", label: "A", status: "stopped" },
    { key: "d", label: "D", status: "running" },
  ]);
  flush();
  expect(muted()).toEqual(["a"]);
});
