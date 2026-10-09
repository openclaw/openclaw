import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import "../styles.css";
import "../styles/settings.css";
import { renderNode } from "./config-form.node.ts";
import type { JsonSchema } from "./config-form.shared.ts";

let container: HTMLDivElement;
afterEach(() => container?.remove());

it("shows inherited scalar defaults muted without authoring them", async () => {
  container = document.body.appendChild(document.createElement("div"));
  const patch = vi.fn();
  const draw = (schema: JsonSchema, value: unknown) =>
    render(
      renderNode({
        schema,
        value,
        path: ["sample"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch: patch,
      }),
      container,
    );
  draw({ type: "boolean", default: true }, undefined);
  const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(toggle.checked).toBe(true);
  expect(getComputedStyle(toggle.closest(".settings-row__control")!).opacity).toBe("0.55");
  expect(toggle.hasAttribute("disabled")).toBe(false);
  expect(patch).not.toHaveBeenCalled();
  await userEvent.click(toggle);
  expect(patch).toHaveBeenLastCalledWith(["sample"], false);
  draw({ type: "boolean", default: true }, false);
  expect(container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
  expect(getComputedStyle(toggle.closest(".settings-row__control")!).opacity).toBe("1");
  draw({ type: "string", enum: ["steer", "queue"], default: "queue" }, undefined);
  const segmented = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
  expect(segmented.querySelector<HTMLInputElement>("input:checked")!.value).toBe("1");
  expect(getComputedStyle(segmented.parentElement!).opacity).toBe("0.55");
  draw({ type: "string", default: "claw" }, undefined);
  const input = container.querySelector<HTMLInputElement>("input")!;
  expect(input.value).toBe("");
  expect(input.placeholder).toContain("claw");
  expect(getComputedStyle(input.parentElement!).opacity).toBe("0.55");
});

it("names a dynamic inherited enum without selecting a guessed literal", () => {
  container = document.body.appendChild(document.createElement("div"));
  const patch = vi.fn();
  render(
    renderNode({
      schema: { type: "string", enum: ["steer", "queue"] },
      value: undefined,
      path: ["mode"],
      hints: { mode: { placeholder: "Default: server queue mode", inheritedDefault: true } },
      unsupported: new Set(),
      disabled: false,
      onPatch: patch,
    }),
    container,
  );
  const select = container.querySelector<HTMLSelectElement>("select");
  expect(select).not.toBeNull();
  expect(select!.selectedOptions[0]!.textContent?.trim()).toBe("Default: server queue mode");
  expect(patch).not.toHaveBeenCalled();
});

it("does not mistake example placeholders or sensitive defaults for public inherited values", () => {
  container = document.body.appendChild(document.createElement("div"));
  const draw = (
    schema: JsonSchema,
    hints: Parameters<typeof renderNode>[0]["hints"],
    maskSensitive = false,
  ) =>
    render(
      renderNode({
        schema,
        value: undefined,
        path: ["sample"],
        hints,
        unsupported: new Set(),
        disabled: false,
        onPatch: vi.fn(),
        maskSensitive,
      }),
      container,
    );
  draw({ type: "string" }, { sample: { placeholder: "https://example.test" } });
  const input = container.querySelector<HTMLInputElement>("input")!;
  expect(input.placeholder).toBe("https://example.test");
  expect(getComputedStyle(input.parentElement!).opacity).toBe("1");
  draw(
    { type: "string", default: "synthetic-secret-default" },
    { sample: { sensitive: true } },
    true,
  );
  expect(container.textContent).not.toContain("synthetic-secret-default");
  expect(container.querySelector<HTMLInputElement>("input")!.placeholder).not.toContain(
    "synthetic-secret-default",
  );
});

it("authors, clears, and rejects explicit enum overrides without materializing inheritance", () => {
  container = document.body.appendChild(document.createElement("div"));
  const patch = vi.fn();
  const draw = (value: unknown, accept = true) =>
    render(
      renderNode({
        schema: { type: "string", enum: ["a", "b", "c", "d", "e", "f"], default: "b" },
        value,
        path: ["sample"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch: (path, next) => {
          patch(path, next);
          return accept;
        },
      }),
      container,
    );
  draw(undefined);
  const select = container.querySelector<HTMLSelectElement>("select")!;
  expect(select.value).toBe("__unset__");
  expect(patch).not.toHaveBeenCalled();
  select.value = "2";
  select.dispatchEvent(new Event("change"));
  expect(patch).toHaveBeenLastCalledWith(["sample"], "c");
  draw("c");
  select.value = "__unset__";
  select.dispatchEvent(new Event("change"));
  expect(patch).toHaveBeenLastCalledWith(["sample"], undefined);
  draw(undefined, false);
  select.value = "0";
  select.dispatchEvent(new Event("change"));
  expect(select.value).toBe("__unset__");
});

it("authors an inherited enum default on reselect, but not an explicit or disabled value", async () => {
  container = document.body.appendChild(document.createElement("div"));
  const patch = vi.fn();
  const draw = (value: unknown, disabled = false) =>
    render(
      renderNode({
        schema: { type: "string", enum: ["light", "dark", "system"], default: "system" },
        value,
        path: ["sample"],
        hints: {},
        unsupported: new Set(),
        disabled,
        onPatch: patch,
      }),
      container,
    );
  draw(undefined);
  const selected = container.querySelector<HTMLInputElement>('input[type="radio"][value="2"]')!;
  await userEvent.click(selected);
  expect(patch).toHaveBeenCalledExactlyOnceWith(["sample"], "system");
  draw("system");
  expect(getComputedStyle(selected.closest(".settings-row__control")!).opacity).toBe("1");
  patch.mockClear();
  await userEvent.click(selected);
  expect(patch).not.toHaveBeenCalled();
  draw(undefined, true);
  selected.click();
  expect(patch).not.toHaveBeenCalled();
});
