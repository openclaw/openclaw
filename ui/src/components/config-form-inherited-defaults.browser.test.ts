import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import "../styles.css";
import "../styles/settings.css";
import {
  disposeConfigFormFixture,
  renderNodeFixture,
} from "../test-helpers/config-form-fixtures.tsx";

let container: HTMLDivElement;
afterEach(() => {
  if (container) {
    disposeConfigFormFixture(container);
    container.remove();
  }
});

it("names a dynamic inherited enum without selecting a guessed literal", () => {
  container = document.body.appendChild(document.createElement("div"));
  const patch = vi.fn();
  renderNodeFixture(container, {
    schema: { type: "string", enum: ["steer", "queue"] },
    value: undefined,
    path: ["mode"],
    hints: { mode: { placeholder: "Default: server queue mode", inheritedDefault: true } },
    unsupported: new Set(),
    disabled: false,
    onPatch: patch,
  });
  const select = container.querySelector<HTMLSelectElement>("select");
  expect(select).not.toBeNull();
  expect(select!.selectedOptions[0]!.textContent?.trim()).toBe("Default: server queue mode");
  expect(patch).not.toHaveBeenCalled();
});

it("authors an inherited enum default on reselect, but not an explicit or disabled value", async () => {
  container = document.body.appendChild(document.createElement("div"));
  const patch = vi.fn();
  const draw = (value: unknown, disabled = false) =>
    renderNodeFixture(container, {
      schema: { type: "string", enum: ["light", "dark", "system"], default: "system" },
      value,
      path: ["sample"],
      hints: {},
      unsupported: new Set(),
      disabled,
      onPatch: patch,
    });
  draw(undefined);
  const selected = container.querySelector<HTMLInputElement>('input[type="radio"][value="2"]')!;
  await userEvent.click(selected);
  expect(patch).toHaveBeenCalledExactlyOnceWith(["sample"], "system");
  draw("system");
  patch.mockClear();
  await userEvent.click(selected);
  expect(patch).not.toHaveBeenCalled();
  draw(undefined, true);
  selected.click();
  expect(patch).not.toHaveBeenCalled();
});
