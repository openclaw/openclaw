import { describe, expect, it, onTestFinished } from "vitest";
import { updateConfigFormValue, serializeFormForSubmit } from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

function formFixture(
  aliases: Record<string, unknown> | undefined,
  schema: Parameters<typeof analyzeConfigSchema>[0],
  original = false,
) {
  const analysis = analyzeConfigSchema(schema);
  const state = createInitialConfigState();
  state.configSchema = analysis.schema;
  state.configForm = structuredClone({ aliases });
  state.configFormOriginal = original ? { aliases } : null;
  const onPatch = (path: Array<string | number>, value: unknown) =>
    updateConfigFormValue(state, path, value);
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const renderValue = () =>
    renderAnalyzedFormFixture(container, analysis, { value: state.configForm, onPatch });
  const input = (selector: string, root: ParentNode = container) =>
    root.querySelector<HTMLInputElement>(selector)!;
  const add = (root: ParentNode = container) =>
    [...root.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add Entry")!
      .click();
  renderValue();
  return { state, container, renderValue, input, add };
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
  it("generates a custom key without colliding with declared fields", () => {
    const { state, container, renderValue, add } = formFixture(
      { primary: "kept" },
      mapSchema({ properties: { "custom-1": { type: "string" } } }),
    );
    add();
    renderValue();
    const expected = { primary: "kept", "custom-2": "" };
    expect(JSON.parse(serializeFormForSubmit(state))).toEqual({ aliases: expected });
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('.cfg-map input[placeholder="Key"]'),
      ).map((field) => field.value),
    ).toEqual(Object.keys(expected));
  });

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
      const { state, renderValue, input } = formFixture(
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
      const feedback = document.getElementById(key.getAttribute("aria-describedby") ?? "")!;
      expect(feedback.hidden).toBe(false);
      expect(feedback.getAttribute("role")).toBe("alert");
      expect(feedback.textContent).toContain(reason);
      expect(feedback.textContent).not.toContain("__OPENCLAW_REDACTED__");
      expect(feedback.textContent).not.toContain("west");
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
        expect(state.configForm).toEqual(value);
      } else {
        expect(state.configForm).toEqual({ aliases: { corrected: "west", backup: "east" } });
        expect(feedback.hidden).toBe(true);
      }
    },
  );

  it.each(
    ["constructor", "prototype", "__proto__"].flatMap((name) =>
      ["add", "rename", "unset"].map((action) => ({ name, action })),
    ),
  )("edits own $name entries after $action without changing prototypes", ({ name, action }) => {
    const { state, container, renderValue, input, add } = formFixture(
      action === "unset" ? undefined : { primary: "before" },
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
      const host = container.querySelector<HTMLElement>("openclaw-config-form-collection-draft")!;
      flush();
      edit(input("[data-collection-draft-key]", host), name, "input");
      edit(input("[data-collection-draft-value]", host), "before", "input");
      if (action === "add") {
        edit(input('[aria-label="Entry value"]'), "edited", "input");
      }
      renderValue();
      flush();
      expect(input("[data-collection-draft-key]", host)?.value).toBe(name);
      expect(input("[data-collection-draft-value]", host)?.value).toBe("before");
      add(host);
    }
    renderValue();
    const value = container
      .querySelectorAll<HTMLInputElement>('input[aria-label="Entry value"]')
      .item(action === "add" ? 1 : 0);
    edit(value, "edited", "input");
    expect(JSON.parse(serializeFormForSubmit(state))).toEqual({
      aliases: { ...(action === "add" ? { primary: "edited" } : {}), [name]: "edited" },
    });
    expect(Object.getPrototypeOf(state.configForm)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(state.configForm!.aliases)).toBe(Object.prototype);
  });
});
