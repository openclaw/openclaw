import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { baseProps, renderConfigInto } from "./config-view.test-support.tsx";
import type { ConfigProps } from "./view.tsx";
import "../../styles.css";

let container: HTMLElement | undefined;
afterEach(() => {
  cleanupSolid();
  container?.remove();
  vi.restoreAllMocks();
});

it("retains the native raw editor and undo through controlled edits and schema hydration", async () => {
  await page.viewport(1440, 900);
  container = document.body.appendChild(document.createElement("main"));
  container.className = "content content--settings-workspace";
  container.style.height = "900px";
  const root = container;
  let current: ConfigProps = {
    ...baseProps(),
    formMode: "raw",
    raw: '{ "audit": "draft" }',
    originalRaw: "{}",
  };
  current.onRawChange = (raw) => {
    current = { ...current, raw };
    renderConfigInto(current, root);
  };
  renderConfigInto(current, root);
  const input = root.querySelector<HTMLTextAreaElement>(".config-raw-field textarea")!;
  const setter = vi.spyOn(input, "value", "set");
  await userEvent.click(input);
  await userEvent.keyboard("{End}x");
  expect(root.querySelector(".config-raw-field textarea")).toBe(input);
  expect(input.value).toBe('{ "audit": "draft" }x');
  input.setSelectionRange(2, 5);
  current = { ...current, schema: { type: "object", properties: { gateway: { type: "object" } } } };
  renderConfigInto(current, root);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(setter).not.toHaveBeenCalled();
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(input.value).toBe('{ "audit": "draft" }');
  const onSave = vi.fn();
  renderConfigInto({ ...current, onSave }, root);
  [...root.querySelectorAll<HTMLButtonElement>(".config-raw-actions button")]
    .find((button) => button.textContent?.trim() === "Save")!
    .click();
  expect(onSave).toHaveBeenCalledOnce();
  expect(current.onSave).not.toHaveBeenCalled();
  renderConfigInto({ ...current, raw: '{ "audit": "replacement" }' }, root);
  expect(input.value).toContain("replacement");
});
