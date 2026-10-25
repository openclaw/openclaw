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

function formFixture(
  aliases: Record<string, unknown>,
  schema: Parameters<typeof analyzeConfigSchema>[0],
  original = false,
) {
  const analysis = analyzeConfigSchema(schema);
  const state = createInitialConfigState();
  state.configSchema = analysis.schema;
  state.configForm = structuredClone({ aliases });
  if (original) {
    state.configFormOriginal = { aliases };
  }
  const onPatch = vi.fn((path: Array<string | number>, value: unknown) =>
    updateConfigFormValue(state, path, value),
  );
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const renderValue = () =>
    renderAnalyzedFormFixture(container, analysis, { value: state.configForm, onPatch });
  const input = (selector: string, root: ParentNode = container) =>
    expectElement(root.querySelector<HTMLInputElement>(selector), selector);
  const add = (root: ParentNode = container) =>
    expectElement(
      [...root.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
      "add entry",
    ).click();
  renderValue();
  return { state, container, onPatch, renderValue, input, add };
}

function edit(input: HTMLInputElement, value: string, event = "change") {
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

const mapSchema = (aliases: Record<string, unknown>) => ({
  type: "object",
  properties: { aliases: { type: "object", additionalProperties: { type: "string" }, ...aliases } },
});

describe("config form map key ownership", () => {
  it.each<{ action: string; expected: Record<string, string> }>([
    { action: "add", expected: { primary: "kept", "custom-2": "" } },
    { action: "rename to declared field", expected: { primary: "kept" } },
    { action: "rename to constructor", expected: { constructor: "kept" } },
  ])(
    "keeps custom keys separate from declared and inherited keys: $action",
    ({ action, expected }) => {
      const { state, container, renderValue, input, add } = formFixture(
        { primary: "kept" },
        mapSchema({ properties: { "custom-1": { type: "string" } } }),
      );
      if (action === "add") {
        add();
      } else {
        edit(
          input('[aria-label="Key: primary"]'),
          action === "rename to declared field" ? "custom-1" : "constructor",
        );
      }
      renderValue();
      expect(JSON.parse(serializeFormForSubmit(state))).toEqual({ aliases: expected });
      expect(
        Array.from(
          container.querySelectorAll<HTMLInputElement>('.cfg-map input[placeholder="Key"]'),
        ).map((field) => field.value),
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
      const value = {
        aliases: {
          primary: kind === "redacted" ? "__OPENCLAW_REDACTED__" : "west",
          backup: "east",
        },
      };
      const { state, onPatch, renderValue, input } = formFixture(
        value.aliases,
        mapSchema({
          properties: { declared: { type: "string" } },
          ...(kind === "parent" ? { const: { primary: "west", backup: "east" } } : {}),
          propertyNames: { type: "string", pattern: "^[a-z]+$" },
        }),
      );
      const key = input('[aria-label="Key: primary"]');
      edit(key, attempt);
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
      edit(key, "corrected", "input");
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
    const { state, container, renderValue, input, add } = formFixture(
      { primary: "before" },
      mapSchema({
        additionalProperties: {
          type: "string",
          title: "Entry value",
          pattern: "^(before|edited)$",
        },
      }),
      true,
    );
    if (action === "rename") {
      edit(input('[aria-label="Key: primary"]'), name);
    } else {
      add();
      const host = expectElement(
        container.querySelector<HTMLElement>("openclaw-config-form-collection-draft"),
        "entry draft",
      );
      flush();
      edit(input("[data-collection-draft-key]", host), name, "input");
      edit(input("[data-collection-draft-value]", host), "before", "input");
      flush();
      add(host);
    }
    renderValue();
    const value = expectElement(
      container
        .querySelectorAll<HTMLInputElement>('input[aria-label="Entry value"]')
        .item(action === "add" ? 1 : 0),
      "own entry value",
    );
    edit(value, "edited", "input");
    expect(JSON.parse(serializeFormForSubmit(state))).toEqual({
      aliases: { ...(action === "add" ? { primary: "before" } : {}), [name]: "edited" },
    });
    expect(Object.getPrototypeOf(state.configForm)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(state.configForm!.aliases)).toBe(Object.prototype);
  });
});
