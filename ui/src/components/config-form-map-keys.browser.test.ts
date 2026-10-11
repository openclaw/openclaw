import { describe, expect, it } from "vitest";
import { updateConfigFormValue, serializeFormForSubmit } from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.ts";
import { ConfigFormCollectionDraft } from "./config-form-collection-draft.ts";
import { analyzeConfigSchema } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form map key ownership", () => {
  it.each<{ action: string; expected: Record<string, string> }>([
    { action: "add", expected: { primary: "kept", "custom-2": "" } },
    { action: "rename to declared field", expected: { primary: "kept" } },
    { action: "rename to constructor", expected: { constructor: "kept" } },
  ])(
    "keeps custom keys separate from declared and inherited keys: $action",
    ({ action, expected }) => {
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          aliases: {
            type: "object",
            properties: { "custom-1": { type: "string" } },
            additionalProperties: { type: "string" },
          },
        },
      });
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configForm = { aliases: { primary: "kept" } };
      const container = document.createElement("div");
      const renderValue = () =>
        renderAnalyzedFormFixture(container, analysis, {
          value: state.configForm,
          onPatch: (path, value) => updateConfigFormValue(state, path, value),
        });
      renderValue();
      if (action === "add") {
        expectElement(
          Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Add Entry",
          ),
          "add custom entry",
        ).click();
      } else {
        const key = expectElement(
          container.querySelector<HTMLInputElement>('[aria-label="Key: primary"]'),
          "custom entry key",
        );
        key.value = action === "rename to declared field" ? "custom-1" : "constructor";
        key.dispatchEvent(new Event("change", { bubbles: true }));
      }
      expect(JSON.parse(serializeFormForSubmit(state))).toEqual({ aliases: expected });
      renderValue();
      expect(
        Array.from(
          container.querySelectorAll<HTMLInputElement>('.cfg-map input[placeholder="Key"]'),
        ).map((input) => input.value),
      ).toEqual(Object.keys(expected));
    },
  );

  it.each(
    ["constructor", "prototype", "__proto__"].flatMap((name) =>
      ["add", "rename"].map((action) => ({ name, action })),
    ),
  )(
    "edits own $name entries after $action without changing prototypes",
    async ({ name, action }) => {
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          aliases: {
            type: "object",
            additionalProperties: {
              type: "string",
              title: "Entry value",
              pattern: "^(before|edited)$",
            },
          },
        },
      });
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configFormOriginal = { aliases: { primary: "before" } };
      state.configForm = structuredClone(state.configFormOriginal);
      const container = document.createElement("div");
      document.body.append(container);
      const renderValue = () =>
        renderAnalyzedFormFixture(container, analysis, {
          value: state.configForm,
          onPatch: (path, value) => updateConfigFormValue(state, path, value),
        });
      try {
        renderValue();
        if (action === "rename") {
          const key = expectElement(
            container.querySelector<HTMLInputElement>('[aria-label="Key: primary"]'),
            "existing key",
          );
          key.value = name;
          key.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          expectElement(
            Array.from(container.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "Add Entry",
            ),
            "add entry",
          ).click();
          const host = expectElement(
            container.querySelector<ConfigFormCollectionDraft>(
              "openclaw-config-form-collection-draft",
            ),
            "entry draft",
          );
          await host.updateComplete;
          const key = expectElement(
            host.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
            "draft key",
          );
          const value = expectElement(
            host.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
            "draft value",
          );
          key.value = name;
          key.dispatchEvent(new Event("input", { bubbles: true }));
          value.value = "before";
          value.dispatchEvent(new Event("input", { bubbles: true }));
          await host.updateComplete;
          expectElement(
            Array.from(host.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "Add Entry",
            ),
            "commit entry",
          ).click();
        }
        renderValue();
        const value = expectElement(
          container
            .querySelectorAll<HTMLInputElement>('input[aria-label="Entry value"]')
            .item(action === "add" ? 1 : 0),
          "own entry value",
        );
        value.value = "edited";
        value.dispatchEvent(new Event("input", { bubbles: true }));
        expect(JSON.parse(serializeFormForSubmit(state))).toEqual({
          aliases: { ...(action === "add" ? { primary: "before" } : {}), [name]: "edited" },
        });
        expect(Object.getPrototypeOf(state.configForm)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(state.configForm!.aliases)).toBe(Object.prototype);
      } finally {
        container.remove();
      }
    },
  );
});
