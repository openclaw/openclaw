import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionSchemaFixture,
  disposeConfigFormFixture,
  renderArrayFixture,
  renderNodeFixture,
  renderTextInputFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";

function input(container: Element, selector: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(selector)!;
}

function fill(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

describe("config form draft lifetimes", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.body.appendChild(document.createElement("div"));
  });
  afterEach(() => {
    disposeConfigFormFixture(container);
    container.remove();
  });
  it("preserves an invalid JSON draft on an equal acknowledgment until its source changes", () => {
    const onPatch = vi.fn();
    const render = (replaced: boolean) =>
      renderNodeFixture(container, {
        schema: { anyOf: [{ type: "object" }, { type: "array" }] },
        value: { enabled: !replaced },
        path: ["value"],
        onPatch,
      });
    render(false);
    const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
    const invalidDraft = { value: '{"enabled":', validity: { valid: false } };
    field.focus();
    field.value = invalidDraft.value;
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(field).toMatchObject(invalidDraft);
    expect(onPatch).not.toHaveBeenCalled();

    render(false);
    expect(container.querySelector("textarea")).toBe(field);
    expect(field).toMatchObject({ ...invalidDraft, selectionStart: 1 });
    expect(container.querySelector<HTMLElement>(".cfg-field__error")?.hidden).toBe(false);

    render(true);
    expect(field.value).toContain('"enabled": false');
    expect(field.checkValidity()).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("false");
    expect(container.querySelector<HTMLElement>(".cfg-field__error")?.hidden).toBe(true);
  });

  it("retains the focused scalar edit's string branch across a numeric source replacement", () => {
    const onPatch = vi.fn();
    const render = (value: string | number) =>
      renderTextInputFixture(container, {
        schema: { anyOf: [{ type: "string" }, { type: "number" }] },
        value,
        sourceIdentity: {},
        path: ["value"],
        inputType: "text",
        onPatch,
      });
    render("initial");
    const field = input(container, "input");
    field.focus();
    fill(field, "12");
    expect(onPatch).toHaveBeenLastCalledWith(["value"], "12");
    render(100);
    expect(field.value).toBe("12");
    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["value"], "12");
  });

  it.each([{ initial: undefined }, { initial: [] }])(
    "retains a collection draft across unchanged $initial sources",
    ({ initial }) => {
      let value: string[] | undefined = initial;
      const onPatch = vi.fn(() => false);
      const render = () =>
        renderArrayFixture(container, {
          schema: { type: "array", items: { type: "string", minLength: 3 } },
          value,
          path: ["names"],
          onPatch,
        });
      render();
      const open = () => {
        container.querySelector<HTMLButtonElement>("button[aria-controls]")!.click();
        flush();
      };
      open();
      onPatch.mockClear();
      let field = input(container, "[data-collection-draft-value]");
      expect(document.activeElement).toBe(field);
      fill(field, "x");
      container.querySelector<HTMLButtonElement>(".cfg-collection-draft__actions button")!.click();
      flush();
      expect(field.checkValidity()).toBe(false);
      expect(onPatch).not.toHaveBeenCalled();

      value = initial?.slice();
      render();
      field = input(container, "[data-collection-draft-value]");
      expect(field).toMatchObject({ value: "x", validity: { valid: false } });
      fill(field, "local");
      expect(field.checkValidity()).toBe(true);

      value = ["remote"];
      render();
      expect(container.querySelector(".cfg-collection-draft")).toBeNull();
      open();
      field = input(container, "[data-collection-draft-value]");
      expect(field).toMatchObject({ value: "", validity: { valid: true } });
      expect(document.activeElement).toBe(field);
    },
  );

  it("keeps rejected structured edits until their source identity changes", () => {
    let sourceIdentity = {};
    const onPatch = vi.fn(() => false);
    const render = () =>
      renderNodeFixture(container, {
        schema: connectionSchemaFixture(),
        value: undefined,
        sourceIdentity,
        path: ["connection"],
        onPatch,
      });
    render();
    fill(input(container, "input[aria-label='Host']"), "gateway.local");
    fill(input(container, "input[aria-label='Port']"), "18789");
    render();
    expect(input(container, "input[aria-label='Host']").value).toBe("gateway.local");
    expect(container.querySelector(".cfg-structured-draft__error")).not.toBeNull();

    sourceIdentity = {};
    render();
    expect(input(container, "input[aria-label='Host']").value).toBe("");
    expect(container.querySelector(".cfg-structured-draft__error")).toBeNull();
  });
});
