import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Tabs, TabPanel } from "./tabs.tsx";

afterEach(cleanup);

it("keeps controlled selection authoritative through rejection, acceptance, and keyed reorder", () => {
  const [active, setActive] = createSignal<string | null>("a");
  const [items, setItems] = createSignal([
    { value: "a", id: "a-tab", panelId: "a-panel", label: "Alpha" },
    {
      value: "b",
      id: "b-tab",
      panelId: "b-panel",
      label: "Beta",
      className: ["custom-tab", { emphasized: true }],
    },
  ]);
  let reject = true;
  const onSelect = vi.fn((value: string): boolean => {
    if (reject) {
      return false;
    }
    setActive(value);
    return true;
  });
  const view = render(() => (
    <>
      <Tabs items={items()} active={active()} ariaLabel="Example" onSelect={onSelect} />
      <TabPanel id="a-panel" tabId="a-tab" active={active() === "a"}>
        Alpha content
      </TabPanel>
      <TabPanel id="b-panel" tabId="b-tab" active={active() === "b"}>
        Beta content
      </TabPanel>
    </>
  ));
  flush();
  const beta = view.getByRole("tab", { name: "Beta" });
  expect(beta.classList.contains("custom-tab")).toBe(true);
  expect(beta.classList.contains("emphasized")).toBe(true);
  fireEvent.click(beta);
  expect(view.getByRole("tab", { selected: true })).toHaveProperty("id", "a-tab");
  expect(view.getByRole("tabpanel")).toHaveProperty("id", "a-panel");
  reject = false;
  fireEvent.click(beta);
  flush();
  expect(view.getByRole("tab", { selected: true })).toBe(beta);
  expect(view.getByRole("tabpanel")).toHaveProperty("id", "b-panel");
  setItems((current) =>
    current
      .toReversed()
      .map((item) => Object.assign({}, item, { className: ["custom-tab", { emphasized: false }] })),
  );
  flush();
  expect(view.getAllByRole("tab")[0]).toBe(beta);
  expect(beta.classList.contains("custom-tab")).toBe(true);
  expect(beta.classList.contains("emphasized")).toBe(false);
  expect(onSelect).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent.click(beta);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("preserves local selection and manual focus, then resets on a new default", () => {
  const [initial, setInitial] = createSignal<string | null>("a");
  const [manual, setManual] = createSignal(true);
  const [items, setItems] = createSignal([
    { value: "a", label: "Alpha" },
    { value: "blocked", label: "Blocked", attributes: { "aria-disabled": "true" as const } },
    { value: "b", label: "Beta" },
  ]);
  const view = render(() => (
    <Tabs
      items={items()}
      defaultActive={initial()}
      activation={manual() ? "manual" : "auto"}
      ariaLabel="Local"
    />
  ));
  flush();
  const alpha = view.getByRole("tab", { name: "Alpha" });
  const beta = view.getByRole("tab", { name: "Beta" });
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  flush();
  expect(document.activeElement).toBe(beta);
  expect(beta.tabIndex).toBe(0);
  expect(alpha.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(beta, { key: "Enter" });
  flush();
  expect(beta.hasAttribute("active")).toBe(true);
  setItems((current) => current.toReversed());
  flush();
  expect(beta.hasAttribute("active")).toBe(true);
  setInitial(null);
  flush();
  expect(view.queryByRole("tab", { selected: true })).toBeNull();
  setManual(false);
  flush();
  fireEvent.keyDown(beta, { key: "End" });
  flush();
  expect(document.activeElement).toBe(alpha);
  expect(alpha.hasAttribute("active")).toBe(true);
  expect(view.getByRole("tab", { name: "Blocked" }).tabIndex).toBe(-1);
});
