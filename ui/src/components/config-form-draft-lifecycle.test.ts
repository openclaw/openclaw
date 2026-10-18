import { describe, expect, it, vi } from "vitest";
import {
  disposeConfigFormFixture,
  renderArrayFixture,
  renderNodeFixture,
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
