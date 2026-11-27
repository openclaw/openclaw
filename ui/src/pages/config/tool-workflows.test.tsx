/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { ToolWorkflows } from "./tool-workflows.tsx";

function mount(config: Record<string, unknown>) {
  const onPatch = vi.fn();
  const mounted = mountSolid(() => (
    <ToolWorkflows config={config} disabled={false} onPatch={onPatch} />
  ));
  const toggle = (name: string) =>
    [...mounted.container.querySelectorAll<HTMLElement>(".settings-row")]
      .find((row) => row.querySelector(".settings-row__title")?.textContent === name)!
      .querySelector<HTMLInputElement>('input[role="switch"]')!;
  return { ...mounted, onPatch, toggle };
}

it.each([
  [undefined, true],
  [false, false],
  [true, true],
  ["auto", true],
  [{}, false],
  [{ timeoutMs: 5000 }, false],
  [{ enabled: false }, false],
  [{ enabled: true }, true],
  [{ enabled: "auto" }, true],
])("reads Code Mode %j without rewriting the saved policy", (codeMode, enabled) => {
  const view = mount({ tools: { codeMode } });
  expect(view.toggle("Code Mode").checked).toBe(enabled);
  expect(view.onPatch).not.toHaveBeenCalled();
});

it.each([
  [undefined, true],
  [false, false],
  [true, true],
  [{}, false],
  [{ mode: "directory" }, true],
  [{ enabled: false, mode: "directory" }, false],
  [{ enabled: true, maxSearchLimit: 3 }, true],
])("reads Tool Search %j without rewriting the saved choice", (toolSearch, enabled) => {
  const view = mount({ tools: { toolSearch } });
  expect(view.toggle("Tool Search").checked).toBe(enabled);
  expect(view.onPatch).not.toHaveBeenCalled();
});

it("selects Auto, never force-on, and retains Code Mode options", () => {
  const view = mount({
    tools: { codeMode: { enabled: false, executor: "quickjs", timeoutMs: 5000 } },
  });
  view.toggle("Code Mode").click();
  expect(view.onPatch).toHaveBeenCalledExactlyOnceWith(["tools", "codeMode"], {
    enabled: "auto",
    executor: "quickjs",
    timeoutMs: 5000,
  });
});

it("disables Tool Search without losing its mode or limits", () => {
  const view = mount({ tools: { toolSearch: { mode: "directory", maxSearchLimit: 3 } } });
  view.toggle("Tool Search").click();
  expect(view.onPatch).toHaveBeenCalledExactlyOnceWith(["tools", "toolSearch"], {
    enabled: false,
    mode: "directory",
    maxSearchLimit: 3,
  });
});

it.each([
  [undefined, { enabled: "auto", executor: "quickjs" }],
  [false, { enabled: false, executor: "quickjs" }],
  [true, { enabled: true, executor: "quickjs" }],
  ["auto", { enabled: "auto", executor: "quickjs" }],
  [{ timeoutMs: 5000 }, { timeoutMs: 5000, executor: "quickjs" }],
])("preserves %j activation while choosing an executor", (codeMode, expected) => {
  const view = mount({ tools: { codeMode } });
  const executor = view.container.querySelector<HTMLSelectElement>("select")!;
  executor.value = "quickjs";
  executor.dispatchEvent(new Event("change", { bubbles: true }));
  expect(view.onPatch).toHaveBeenCalledExactlyOnceWith(["tools", "codeMode"], expected);
});

it("reflects live owner changes and respects mutation disablement", () => {
  let update!: (config: Record<string, unknown>) => void;
  let disable!: (value: boolean) => void;
  const onPatch = vi.fn();
  const view = mountSolid(() => {
    const [config, setConfig] = createSignal<Record<string, unknown>>({});
    const [disabled, setDisabled] = createSignal(false);
    update = setConfig;
    disable = setDisabled;
    return <ToolWorkflows config={config()} disabled={disabled()} onPatch={onPatch} />;
  });
  update({ tools: { codeMode: false, toolSearch: false } });
  disable(true);
  flush();
  for (const toggle of view.container.querySelectorAll<HTMLInputElement>("input")) {
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    toggle.click();
  }
  expect(onPatch).not.toHaveBeenCalled();
});
