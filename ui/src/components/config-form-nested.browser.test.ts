// Control UI tests cover how nested config objects read: in place, as one setting, or as a group.
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectElement, renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { JsonSchema } from "./config-form.shared.ts";

const string = (title: string, description?: string): JsonSchema => ({
  type: "string",
  title,
  ...(description ? { description } : {}),
});

let container: HTMLElement;

function render(lab: JsonSchema, value: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const onPatch = vi.fn();
  renderAnalyzedFormFixture(
    container,
    analyzeConfigSchema({ type: "object", properties: { lab } }),
    { value: { lab: value }, onPatch },
  );
  return onPatch;
}

const modelUnion: JsonSchema = {
  title: "Model",
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        primary: string("Primary model"),
        fallbacks: { type: "array", title: "Model fallbacks", items: { type: "string" } },
      },
    },
  ],
};

function titles() {
  // The form's Advanced settings row is not one of the settings under test.
  const rows = ".settings-row:not(.settings-disclosure__summary) .settings-row__title";
  return [...container.querySelectorAll(rows)].map((title) => title.textContent?.trim());
}

afterEach(() => {
  container?.remove();
});

describe("config form nested objects", () => {
  it("reads settings first, then lists, then closed groups", () => {
    render({
      type: "object",
      properties: {
        group: {
          type: "object",
          title: "Group",
          properties: { first: string("First"), second: string("Second") },
        },
        names: { type: "array", title: "Names", items: { type: "string" } },
        mode: string("Mode"),
      },
    });
    expect(titles()).toEqual(["Mode", "Names", "Group"]);
    const group = expectElement(
      container.querySelector<HTMLDetailsElement>("details.cfg-object"),
      "group",
    );
    expect(group.open).toBe(false);
    expect(group.querySelector("input")).toBeNull();
  });

  it("shows an object holding one setting about itself as that setting", () => {
    render({
      type: "object",
      properties: {
        mode: string("Mode"),
        catalog: {
          type: "object",
          title: "Catalog refresh",
          description: "Parent help that only this object carries.",
          properties: { enabled: string("Catalog refresh URL") },
        },
      },
    });
    expect(container.querySelector("details.cfg-object")).toBeNull();
    expect(titles()).toEqual(["Catalog refresh URL", "Mode"]);
    expect(
      container.querySelector('button[aria-label="Help for Catalog refresh URL"]'),
    ).not.toBeNull();
  });

  it("shows the fields of a level's only group in place", () => {
    render({
      type: "object",
      properties: {
        only: {
          type: "object",
          title: "Only group",
          properties: { first: string("First"), second: string("Second") },
        },
      },
    });
    expect(container.querySelector("details.cfg-object")).toBeNull();
    expect(titles()).toEqual(["First", "Second"]);
  });

  it.each([
    ["unset", {}],
    ["written as an object", { model: { primary: "provider/a" } }],
  ])("shows a string-or-object setting %s as its named fields", (_state, value) => {
    render({ type: "object", properties: { mode: string("Mode"), model: modelUnion } }, value);
    expect(container.querySelector("textarea")).toBeNull();
    expect(titles()).toEqual(["Mode", "Model"]);
    expect(container.querySelector("details.cfg-object")).not.toBeNull();
  });

  it("keeps a string-or-object setting written as a string in a text field", () => {
    const onPatch = render(
      { type: "object", properties: { mode: string("Mode"), model: modelUnion } },
      { model: "provider/a" },
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>('input[aria-label="Model"]'),
      "model input",
    );
    expect(input.value).toBe("provider/a");
    expect(container.querySelector("textarea")).toBeNull();
    input.value = "provider/b";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["lab", "model"], "provider/b");
  });

  it("shows a map as one row with its own label and Add", () => {
    render({
      type: "object",
      properties: {
        mode: string("Mode"),
        providers: {
          type: "object",
          title: "Providers",
          additionalProperties: {
            type: "object",
            properties: { url: string("URL") },
          },
        },
      },
    });
    expect(container.querySelector("details.cfg-object")).toBeNull();
    expect(titles()).toEqual(["Mode", "Providers"]);
    expect(container.textContent).not.toContain("Custom entries");
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        /^Add( entry)?$/i.test(button.textContent?.trim() ?? ""),
      ),
    ).toBe(true);
  });
});
