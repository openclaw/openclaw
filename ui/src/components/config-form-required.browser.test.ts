// Control UI tests cover required cues without introducing native validation.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
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
  const element = container.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('[aria-label="' + label + '"]');
  if (!element) {
    throw new Error("Missing " + label);
  }
  return element;
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
    const properties: Record<string, JsonSchema> = {};
    const value: Record<string, unknown> = {};
    for (const [kind, schema] of Object.entries(fieldTypes)) {
      for (const prefix of ["required", "optional"]) {
        const key = prefix + kind;
        properties[key] = { ...schema, title: key };
        value[key] = values[kind];
      }
    }
    properties.typedMap = {
      type: "object",
      additionalProperties: { type: "string", title: "Typed entry" },
    };
    properties.jsonMap = { type: "object", additionalProperties: {} };
    value.typedMap = { custom: "example" };
    value.jsonMap = { raw: { enabled: true } };
    const { container, onPatch } = render(
      properties,
      Object.keys(properties).filter((key) => key.startsWith("required")),
      value,
    );
    for (const kind of Object.keys(fieldTypes)) {
      const required = control(container, "required" + kind);
      const optional = control(container, "optional" + kind);
      expect(required.getAttribute("aria-required"), kind).toBe("true");
      expect(optional.getAttribute("aria-required"), kind).toBeNull();
      expect(required.hasAttribute("required"), kind).toBe(false);
      expect(required.closest(".settings-row")?.textContent).toContain("Required");
      expect(optional.closest(".settings-row")?.textContent).not.toContain("Required");
    }
    for (const label of ["Typed entry", "raw: JSON value"]) {
      const unlabeled = control(container, label);
      expect(unlabeled.getAttribute("aria-required")).toBe("true");
      expect(unlabeled.closest(".settings-row")?.textContent).toContain("Required");
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
      const group = container.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
      expect(group).not.toBeNull();
      expect(group?.getAttribute("aria-required"), label).toBe(required ? "true" : null);
      expect(group?.closest(".settings-row")?.textContent?.includes("Required"), label).toBe(
        required,
      );
      expect(group?.querySelector("[required]")).toBeNull();
    }
    expect(onPatch).not.toHaveBeenCalled();
    const first = container.querySelector<HTMLInputElement>(
      '[role="radiogroup"][aria-label="Short choice"] input',
    );
    if (!first) {
      throw new Error("Missing first required choice");
    }
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["laboratory", "requiredChoice"], "b");
  });

  it("does not request manual input for direct or inherited valid defaults", () => {
    const properties = Object.fromEntries(
      Object.entries(fieldTypes).map(([kind, schema]) => [
        kind,
        { ...schema, title: kind, default: values[kind] },
      ]),
    );
    const direct = render(properties, Object.keys(fieldTypes), {});
    const inherited = render(
      {
        inherited: {
          type: "object",
          default: values,
          required: Object.keys(fieldTypes),
          properties: Object.fromEntries(
            Object.entries(fieldTypes).map(([kind, schema]) => [kind, { ...schema, title: kind }]),
          ),
        },
      },
      [],
      {},
    );
    for (const { container, onPatch } of [direct, inherited]) {
      for (const kind of Object.keys(fieldTypes)) {
        const field = control(container, kind);
        expect(field.getAttribute("aria-required"), kind).toBeNull();
        expect(field.hasAttribute("required"), kind).toBe(false);
        expect(field.closest(".settings-row")?.textContent).not.toContain("Required");
      }
      expect(onPatch).not.toHaveBeenCalled();
    }
  });
});
