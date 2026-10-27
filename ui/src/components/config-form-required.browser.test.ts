import { describe, expect, it, onTestFinished, vi } from "vitest";
import { expectElement, renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { JsonSchema } from "./config-form.shared.ts";

const fieldTypes: Record<string, JsonSchema> = {
  text: { type: "string", minLength: 1 },
  number: { type: "integer" },
  choice: { type: "string", enum: ["a", "b", "c", "d", "e", "f"] },
  json: { anyOf: [{ type: "object" }, { type: "array" }] },
};
const values: Record<string, unknown> = {
  text: "example",
  number: 3,
  choice: "a",
  json: { enabled: true },
};

function control(container: HTMLElement, label: string) {
  return expectElement(
    container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[aria-label="${label}"]`,
    ),
    label,
  );
}

function fieldsWithDefaults(defaults: boolean, prefix = "") {
  return Object.fromEntries(
    Object.entries(fieldTypes).map(([kind, schema]) => [
      prefix + kind,
      { ...schema, title: prefix + kind, ...(defaults ? { default: values[kind] } : {}) },
    ]),
  );
}

function expectRequired(field: Element, required: boolean) {
  expect(field.getAttribute("aria-required")).toBe(required ? "true" : null);
  expect(field.hasAttribute("required")).toBe(false);
  expect(field.closest(".settings-row")?.textContent?.includes("Required")).toBe(required);
}

function render(properties: Record<string, JsonSchema>, required: string[], value: unknown) {
  const container = document.createElement("div");
  const onPatch = vi.fn();
  const analysis = analyzeConfigSchema({
    type: "object",
    properties: { laboratory: { type: "object", properties, required } },
  });
  renderAnalyzedFormFixture(container, analysis, { value: { laboratory: value }, onPatch });
  return { container, onPatch };
}

describe("config field required semantics", () => {
  it("marks required text, number, enum and JSON while preserving names and validation", () => {
    const properties = {
      ...fieldsWithDefaults(false, "required"),
      ...fieldsWithDefaults(false, "optional"),
      typedMap: { type: "object", additionalProperties: { type: "string", title: "Typed entry" } },
      jsonMap: { type: "object", additionalProperties: {} },
    } satisfies Record<string, JsonSchema>;
    const value = {
      ...Object.fromEntries(
        ["required", "optional"].flatMap((prefix) =>
          Object.entries(values).map(([kind, fieldValue]) => [prefix + kind, fieldValue]),
        ),
      ),
      typedMap: { custom: "example" },
      jsonMap: { raw: { enabled: true } },
    };
    const { container, onPatch } = render(
      properties,
      Object.keys(properties).filter((key) => key.startsWith("required")),
      value,
    );
    for (const kind of Object.keys(fieldTypes)) {
      expectRequired(control(container, "required" + kind), true);
      expectRequired(control(container, "optional" + kind), false);
    }
    for (const label of ["Typed entry", "raw: JSON value"]) {
      expectRequired(control(container, label), true);
    }
    const required = control(container, "requiredtext");
    required.value = "";
    required.dispatchEvent(new Event("input", { bubbles: true }));
    expect(required.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();
    required.value = "updated";
    required.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["laboratory", "requiredtext"], "updated");
    const optional = control(container, "optionaltext");
    optional.value = "";
    optional.dispatchEvent(new Event("input", { bubbles: true }));
    expect(optional.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenLastCalledWith(["laboratory", "optionaltext"], undefined);
  });

  it("marks required short enums while preserving optional defaults and keyboard selection", () => {
    const choice = { type: "string", enum: ["a", "b"] } satisfies JsonSchema;
    const { container, onPatch } = render(
      {
        requiredChoice: { ...choice, title: "Short choice" },
        optionalChoice: { ...choice, title: "Optional choice" },
        defaultedChoice: { ...choice, title: "Defaulted choice", default: "a" },
        invalidDefault: { ...choice, title: "Invalid default", default: "invalid" },
      },
      ["requiredChoice", "defaultedChoice", "invalidDefault"],
      { requiredChoice: "a", optionalChoice: "a" },
    );
    document.body.append(container);
    onTestFinished(() => container.remove());
    for (const [label, required] of [
      ["Short choice", true],
      ["Optional choice", false],
      ["Defaulted choice", false],
      ["Invalid default", true],
    ] as const) {
      const group = control(container, label);
      expect(group.getAttribute("role")).toBe("radiogroup");
      expectRequired(group, required);
      expect(group.querySelector("[required]")).toBeNull();
    }
    expect(onPatch).not.toHaveBeenCalled();
    const first = expectElement(
      control(container, "Short choice").querySelector("input"),
      "choice",
    );
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["laboratory", "requiredChoice"], "b");
  });

  it("does not request manual input for direct or inherited valid defaults", () => {
    const direct = render(fieldsWithDefaults(true), Object.keys(fieldTypes), {});
    const inherited = render(
      {
        inherited: {
          type: "object",
          default: values,
          required: Object.keys(fieldTypes),
          properties: fieldsWithDefaults(false),
        },
      },
      [],
      {},
    );
    for (const { container, onPatch } of [direct, inherited]) {
      for (const kind of Object.keys(fieldTypes)) {
        expectRequired(control(container, kind), false);
      }
      expect(onPatch).not.toHaveBeenCalled();
    }
  });
});
