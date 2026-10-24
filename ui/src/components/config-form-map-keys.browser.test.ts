import { describe, expect, it, onTestFinished, vi } from "vitest";
import { updateConfigFormValue, serializeFormForSubmit } from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

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
      document.body.append(container);
      onTestFinished(() => container.remove());
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
      renderValue();
      expect(JSON.parse(serializeFormForSubmit(state))).toEqual({ aliases: expected });
      expect(
        Array.from(
          container.querySelectorAll<HTMLInputElement>('.cfg-map input[placeholder="Key"]'),
        ).map((input) => input.value),
      ).toEqual(Object.keys(expected));
    },
  );

  it.each([
    { kind: "duplicate", attempt: "backup", reason: "already in use" },
    { kind: "reserved", attempt: "declared", reason: "already in use" },
    { kind: "schema", attempt: "bad/key", reason: "matches this setting's constraints" },
    { kind: "redacted", attempt: "renamed", reason: "stored secret" },
    { kind: "empty", attempt: "  ", reason: "matches this setting's constraints" },
    { kind: "parent", attempt: "renamed", reason: "Review its documentation and constraints" },
  ])(
    "explains a rejected $kind rename after restoring the valid key",
    ({ kind, attempt, reason }) => {
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          aliases: {
            type: "object",
            properties: { declared: { type: "string" } },
            ...(kind === "parent" ? { const: { primary: "west", backup: "east" } } : {}),
            propertyNames: { type: "string", pattern: "^[a-z]+$" },
            additionalProperties: { type: "string" },
          },
        },
      });
      const value = {
        aliases: {
          primary: kind === "redacted" ? "__OPENCLAW_REDACTED__" : "west",
          backup: "east",
        },
      };
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configForm = structuredClone(value);
      const onPatch = vi.fn((path: Array<string | number>, next: unknown) =>
        updateConfigFormValue(state, path, next),
      );
      const container = document.createElement("div");
      document.body.append(container);
      onTestFinished(() => container.remove());
      const renderValue = () =>
        renderAnalyzedFormFixture(container, analysis, { value: state.configForm, onPatch });
      renderValue();
      const key = expectElement(
        container.querySelector<HTMLInputElement>('[aria-label="Key: primary"]'),
        "existing key",
      );
      key.value = attempt;
      key.dispatchEvent(new Event("change", { bubbles: true }));
      flush();
      expect(key.value).toBe("primary");
      expect(key.validity.valid).toBe(true);
      expect(key.getAttribute("aria-invalid")).not.toBe("true");
      const feedback = expectElement(
        document.getElementById(key.getAttribute("aria-describedby") ?? ""),
        "associated rename feedback",
      );
      expect(feedback.hidden).toBe(false);
      expect(feedback.getAttribute("role")).toBe("alert");
      expect(feedback.textContent).toContain("Rename not applied");
      expect(feedback.textContent).toContain("original key was kept");
      expect(feedback.textContent).toContain(reason);
      expect(feedback.textContent).not.toContain("__OPENCLAW_REDACTED__");
      expect(feedback.textContent).not.toContain("west");
      expect(onPatch).not.toHaveBeenCalled();
      expect(state.configForm).toEqual(value);
      renderValue();
      expect(feedback.hidden).toBe(false);
      key.focus();
      expect(document.activeElement).toBe(key);
      expect(document.getElementById(key.getAttribute("aria-describedby") ?? "")).toBe(feedback);
      key.value = "corrected";
      key.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(key.value).toBe("corrected");
      expect(feedback.hidden).toBe(true);
      expect(key.getAttribute("aria-describedby")).toBeNull();
      key.dispatchEvent(new Event("change", { bubbles: true }));
      flush();
      if (kind === "redacted" || kind === "parent") {
        expect(key.value).toBe("primary");
        expect(feedback.textContent).toContain(reason);
        expect(onPatch).not.toHaveBeenCalled();
        expect(state.configForm).toEqual(value);
      } else {
        expect(onPatch).toHaveBeenCalledExactlyOnceWith(["aliases"], {
          corrected: "west",
          backup: "east",
        });
        expect(feedback.hidden).toBe(true);
      }
    },
  );

  it.each(
    ["constructor", "prototype", "__proto__"].flatMap((name) =>
      ["add", "rename"].map((action) => ({ name, action })),
    ),
  )("edits own $name entries after $action without changing prototypes", ({ name, action }) => {
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
          container.querySelector<HTMLElement>("openclaw-config-form-collection-draft"),
          "entry draft",
        );
        flush();
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
        flush();
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
  });
});
