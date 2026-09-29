import { describe, expect, it } from "vitest";
import { renderArrayFixture } from "../test-helpers/config-form-fixtures.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form nested array integrity", () => {
  it("preserves an unrelated JSON draft when a sibling field changes", () => {
    const container = document.createElement("div");
    let currentValue: unknown[] = [{ name: "before", payload: { enabled: true } }];
    const renderValue = () => {
      renderArrayFixture(container, {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              payload: {},
            },
          },
        },
        value: currentValue,
        path: ["entries"],
        onPatch: (_path, nextValue) => {
          currentValue = nextValue as unknown[];
          renderValue();
        },
      });
    };

    renderValue();
    const payload = expectElement(
      container.querySelector<HTMLTextAreaElement>("textarea"),
      "payload JSON draft",
    );
    payload.value = "{";
    payload.dispatchEvent(new Event("input", { bubbles: true }));
    expect(payload.getAttribute("aria-invalid")).toBe("true");

    const name = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
      "name input",
    );
    name.value = "after";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new Event("change", { bubbles: true }));

    const currentPayload = expectElement(
      container.querySelector<HTMLTextAreaElement>("textarea"),
      "preserved payload JSON draft",
    );
    expect(currentPayload).toBe(payload);
    expect(currentPayload.value).toBe("{");
    expect(currentPayload.getAttribute("aria-invalid")).toBe("true");
    expect(currentValue).toEqual([{ name: "after", payload: { enabled: true } }]);
  });
});
