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
  renderAnalyzedFormFixture(
    container,
    analyzeConfigSchema({ type: "object", properties: { lab } }),
    { value: { lab: value }, onPatch: vi.fn() },
  );
}

function titles() {
  return [...container.querySelectorAll(".settings-row__title")].map((title) =>
    title.textContent?.trim(),
  );
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
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
    ).toBe(true);
  });
});
