import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Tabs, TabPanel, type TabsProps } from "./tabs.tsx";

afterEach(cleanup);

it("keeps rejected/accepted selection and keyed nodes authoritative", () => {
  const [state, set] = createSignal({
    active: "a",
    items: [
      { value: "a", id: "at", panelId: "ap", label: "A", className: ["custom", { marked: false }] },
      { value: "b", id: "bt", panelId: "bp", label: "B", className: ["custom", { marked: true }] },
    ],
  });
  let reject = true;
  const onSelect = vi.fn((active: string) => void (!reject && set((s) => ({ ...s, active }))));
  const view = render(() => (
    <>
      <Tabs {...state()} ariaLabel="Example" onSelect={onSelect} />
      <TabPanel id="ap" tabId="at" active={state().active === "a"} children="A" />
      <TabPanel id="bp" tabId="bt" active={state().active === "b"} children="B" />
    </>
  ));
  flush();
  const beta = view.getByRole("tab", { name: "B" });
  expect([...beta.classList]).toEqual(expect.arrayContaining(["custom", "marked"]));
  fireEvent.click(beta);
  expect(view.getByRole("tab", { selected: true })).toHaveProperty("id", "at");
  expect(view.getByRole("tabpanel")).toHaveProperty("id", "ap");
  reject = false;
  fireEvent.click(beta);
  flush();
  expect(view.getByRole("tab", { selected: true })).toBe(beta);
  expect(view.getByRole("tabpanel")).toHaveProperty("id", "bp");
  set((previous) => ({
    ...previous,
    items: previous.items
      .toReversed()
      .map((item) => Object.assign({}, item, { className: ["custom", { marked: false }] })),
  }));
  flush();
  expect(view.getAllByRole("tab")[0]).toBe(beta);
  expect(beta.classList.contains("custom")).toBe(true);
  expect(beta.classList.contains("marked")).toBe(false);
  expect(onSelect).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent.click(beta);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("skips aria-disabled tabs in manual and automatic activation", () => {
  const [state, set] = createSignal<Pick<TabsProps, "active" | "activation" | "items">>({
    active: "a",
    activation: "manual",
    items: [
      { value: "a", label: "A" },
      { value: "x", label: "Blocked", attributes: { "aria-disabled": "true" } },
      { value: "b", label: "B" },
    ],
  });
  const onSelect = (active: string) => void set((s) => ({ ...s, active }));
  const view = render(() => <Tabs {...state()} onSelect={onSelect} ariaLabel="Manual" />);
  const key = (element: HTMLElement, name: string) => {
    fireEvent.keyDown(element, { key: name });
    flush();
  };
  flush();
  const alpha = view.getByRole("tab", { name: "A" });
  const beta = view.getByRole("tab", { name: "B" });
  key(alpha, "ArrowRight");
  expect(document.activeElement).toBe(beta);
  expect(beta.tabIndex).toBe(0);
  expect(alpha.getAttribute("aria-selected")).toBe("true");
  set((s) => ({ ...s, activation: "auto" }));
  flush();
  key(alpha, "End");
  expect(document.activeElement).toBe(beta);
  expect(beta.hasAttribute("active")).toBe(true);
  expect(view.getByRole("tab", { name: "Blocked" }).tabIndex).toBe(-1);
});
