import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Tabs, TabPanel } from "./tabs.tsx";

afterEach(cleanup);

it("keeps controlled selection authoritative through rejection, acceptance, and keyed reorder", () => {
  const [active, setActive] = createSignal<string | null>("a");
  const [items, setItems] = createSignal([
    { value: "a", id: "a-tab", panelId: "a-panel", label: "Alpha" },
    { value: "b", id: "b-tab", panelId: "b-panel", label: "Beta" },
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
  fireEvent.click(beta);
  expect(view.getByRole("tab", { selected: true })).toHaveProperty("id", "a-tab");
  expect(view.getByRole("tabpanel")).toHaveProperty("id", "a-panel");
  reject = false;
  fireEvent.click(beta);
  flush();
  expect(view.getByRole("tab", { selected: true })).toBe(beta);
  expect(view.getByRole("tabpanel")).toHaveProperty("id", "b-panel");
  setItems((current) => current.toReversed());
  flush();
  expect(view.getAllByRole("tab")[0]).toBe(beta);
  expect(onSelect).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent.click(beta);
  expect(onSelect).toHaveBeenCalledTimes(2);
});
