import { describe, expect, it, vi } from "vitest";
import {
  disposeConfigFormFixture,
  renderArrayFixture,
  renderJsonTextareaFixture,
  renderNodeFixture,
  renderTextInputFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";

function input(container: Element, selector: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(selector);
  if (!element) {
    throw new Error(`Missing input: ${selector}`);
  }
  return element;
}

function fill(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

describe("config form draft lifetimes", () => {
  it.each(["scalar", "JSON"] as const)(
    "preserves an invalid %s draft on an equal acknowledgment and applies its replacement policy",
    (kind) => {
      const container = document.body.appendChild(document.createElement("div"));
      const onPatch = vi.fn();
      const render = (replaced: boolean) => {
        if (kind === "scalar") {
          renderTextInputFixture(container, {
            schema: { type: "string", minLength: 3 },
            value: replaced ? "remote" : "local",
            sourceIdentity: {},
            path: ["value"],
            inputType: "text",
            onPatch,
          });
        } else {
          renderJsonTextareaFixture(container, {
            schema: { type: "object" },
            value: { enabled: !replaced },
            path: ["value"],
            onPatch,
          });
        }
      };
      try {
        render(false);
        const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        )!;
        const invalid = kind === "scalar" ? "x" : '{"enabled":';
        field.focus();
        field.value = invalid;
        field.setSelectionRange(1, 1);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        flush();
        expect(field.checkValidity()).toBe(false);
        expect(onPatch).not.toHaveBeenCalled();

        render(false);
        expect(container.querySelector("input, textarea")).toBe(field);
        expect(field.value).toBe(invalid);
        expect(field.selectionStart).toBe(1);
        expect(field.checkValidity()).toBe(false);
        expect(container.querySelector<HTMLElement>(".cfg-field__error")?.hidden).toBe(false);

        render(true);
        if (kind === "scalar") {
          expect(field.value).toBe(invalid);
          expect(field.checkValidity()).toBe(false);
          field.blur();
          render(true);
          expect(field.value).toBe("remote");
        } else {
          expect(field.value).toContain('"enabled": false');
        }
        expect(field.checkValidity()).toBe(true);
        expect(field.getAttribute("aria-invalid")).toBe("false");
        expect(container.querySelector<HTMLElement>(".cfg-field__error")?.hidden).toBe(true);
      } finally {
        disposeConfigFormFixture(container);
        container.remove();
      }
    },
  );

  it("retains the focused scalar edit's string branch across a numeric source replacement", () => {
    const container = document.body.appendChild(document.createElement("div"));
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
    try {
      render("initial");
      const field = input(container, "input");
      field.focus();
      fill(field, "12");
      expect(onPatch).toHaveBeenLastCalledWith(["value"], "12");
      render(100);
      expect(field.value).toBe("12");
      field.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(["value"], "12");
    } finally {
      disposeConfigFormFixture(container);
      container.remove();
    }
  });

  it.each([
    { label: "absent", initial: undefined },
    { label: "empty", initial: [] },
  ])("retains a collection draft across unchanged $label sources", ({ initial }) => {
    const container = document.body.appendChild(document.createElement("div"));
    let value: string[] | undefined = initial;
    const onPatch = vi.fn(() => false);
    const render = () =>
      renderArrayFixture(container, {
        schema: { type: "array", items: { type: "string", minLength: 3 } },
        value,
        path: ["names"],
        onPatch,
      });
    try {
      render();
      const open = () => {
        container.querySelector<HTMLButtonElement>("button[aria-controls]")!.click();
        flush();
      };
      open();
      // Opening falls back to the draft after the parent rejects an automatic default.
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
      expect(field.value).toBe("x");
      expect(field.checkValidity()).toBe(false);
      fill(field, "local");
      expect(field.checkValidity()).toBe(true);

      value = ["remote"];
      render();
      expect(container.querySelector(".cfg-collection-draft")).toBeNull();
      open();
      field = input(container, "[data-collection-draft-value]");
      expect(field.value).toBe("");
      expect(field.checkValidity()).toBe(true);
      expect(document.activeElement).toBe(field);
    } finally {
      disposeConfigFormFixture(container);
      container.remove();
    }
  });

  it("keeps rejected structured edits until their source identity changes", () => {
    const container = document.body.appendChild(document.createElement("div"));
    let sourceIdentity = {};
    const onPatch = vi.fn(() => false);
    const render = () =>
      renderNodeFixture(container, {
        schema: {
          type: "object",
          required: ["host", "port"],
          properties: {
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1 },
          },
        },
        value: undefined,
        sourceIdentity,
        path: ["connection"],
        onPatch,
      });
    try {
      render();
      fill(input(container, "input[aria-label='Host']"), "gateway.local");
      expect(onPatch).not.toHaveBeenCalled();
      render();
      expect(input(container, "input[aria-label='Host']").value).toBe("gateway.local");
      fill(input(container, "input[aria-label='Port']"), "18789");
      expect(onPatch).toHaveBeenCalledWith(["connection"], {
        host: "gateway.local",
        port: 18789,
      });
      render();
      expect(input(container, "input[aria-label='Host']").value).toBe("gateway.local");
      expect(container.querySelector(".cfg-structured-draft__error")).not.toBeNull();

      sourceIdentity = {};
      render();
      expect(input(container, "input[aria-label='Host']").value).toBe("");
      expect(container.querySelector(".cfg-structured-draft__error")).toBeNull();
    } finally {
      disposeConfigFormFixture(container);
      container.remove();
    }
  });
});
