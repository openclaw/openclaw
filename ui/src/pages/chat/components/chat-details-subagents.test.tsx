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
    }));
    const { view, setRows, openChild, openCollection } = mountSubagents(initial, mobile);
    const buttons = view.getAllByRole("button");
    expect(buttons).toHaveLength(limit);
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
    expect(openCollection).toHaveBeenCalledTimes(2);
    expect(openChild).toHaveBeenCalledTimes(2);
  },
);

it("omits empty content and removes collapsed activity when the last waiting child settles", () => {
  const { view, setRows, setCollapsed } = mountSubagents([]);
  expect(view.container.childElementCount).toBe(0);
  setCollapsed(true);
  setRows([{ key: "waiting-child", label: "Waiting child", status: "waiting" }]);
  flush();
  expect(view.getByRole("img", { name: "1 subagent running" })).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
  expect(view.container.textContent).toBe("");
  setRows([{ key: "waiting-child", label: "Waiting child", status: "done" }]);
  flush();
  expect(view.container.childElementCount).toBe(0);
  setCollapsed(false);
  flush();
  expect(view.getByRole("button", { name: "Waiting child Done" })).toBeTruthy();
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
  expect(
    view.getByRole("button", {
      name: "All subagents. 1 Working, 1 Waiting on subagents, 1 Queued, 2 Done, 1 Stopped",
    }),
  ).toBeTruthy();
  setRows([initial[4]!]);
  flush();
  view.getByRole("button", { name: "E Failed" }).click();
  expect(openChild).toHaveBeenCalledExactlyOnceWith("e");
});
