import { describe, expect, it, vi } from "vitest";
import {
  renderNodeFixture,
  renderArrayFixture,
  renderObjectFixture,
  expandConfigObjects,
} from "../test-helpers/config-form-fixtures.tsx";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element, label).toBeInstanceOf(Element);
  return element!;
}

type Options = Parameters<typeof renderNodeFixture>[1];
function fixture(
  schema: Options["schema"],
  value: unknown,
  { reject = false, ...options }: Partial<Options> & { reject?: boolean } = {},
) {
  const render =
    schema.type === "array"
      ? renderArrayFixture
      : schema.type === "object"
        ? renderObjectFixture
        : renderNodeFixture;
  const container = document.createElement("div");
  const onPatch = vi.fn(() => (reject ? false : undefined));
  const update = (next: unknown) =>
    render(container, { path: ["settings"], ...options, schema, value: next, onPatch });
  update(value);
  return { container, update, onPatch };
}
const input = (root: ParentNode, label = "input") =>
  expectElement(root.querySelector<HTMLInputElement>("input"), label);
const textarea = (root: ParentNode) =>
  expectElement(root.querySelector<HTMLTextAreaElement>("textarea"), "JSON input");
const findText = (root: ParentNode, selector: string, text: string) =>
  expectElement(
    [...root.querySelectorAll(selector)].find((node) => node.textContent?.includes(text)),
    text,
  );
function edit(element: HTMLInputElement, value: string, composed = true) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed }));
}
const string = { type: "string" as const };
const object = (
  properties: Options["schema"]["properties"],
  options: Partial<Options["schema"]> = {},
): Options["schema"] => ({ type: "object", properties, ...options });
const array = (items: Options["schema"], defaults: unknown[]): Options["schema"] => ({
  type: "array",
  items,
  default: defaults,
});
const entry = (name: string, label: string, note: string) => ({
  name,
  details: { label, note },
});

describe("config form collection defaults", () => {
  it("shows and clears optional JSON defaults without authoring the inherited value", () => {
    const { container, update, onPatch } = fixture(
      { anyOf: [{ type: "object" }, { type: "array" }], default: { mode: "balanced" } },
      { mode: "custom" },
    );

    expect(container.textContent).toContain('Default: {"mode":"balanced"}');
    const json = textarea(container);
    expect(json.value).toBe('{\n  "mode": "custom"\n}');
    json.value = "";
    json.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["settings"], undefined);

    onPatch.mockClear();
    update(undefined);

    expect(container.textContent).not.toContain("Using default:");
    expect(container.querySelector(".settings-row__desc")).toBeNull();
    expect(textarea(container).value).toBe('{\n  "mode": "balanced"\n}');
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("shows optional array defaults and authors inherited items without dropping siblings", () => {
    const { container, update, onPatch } = fixture(array(string, ["a", "b"]), ["custom"], {
      reject: true,
    });

    expect(container.textContent).toContain('Default: ["a","b"]');
    expect(container.textContent).toContain("1 item");
    expect(input(container).value).toBe("custom");

    onPatch.mockClear();
    update(undefined);

    expect(container.textContent).not.toContain("Using default:");
    expect(container.querySelector(".settings-row__desc")).toBeNull();
    expect(container.textContent).toContain("2 items");
    const inheritedInputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inheritedInputs.map((field) => field.value)).toEqual(["", ""]);
    expect(inheritedInputs.map((field) => field.placeholder)).toEqual(["Default: a", "Default: b"]);
    expect(onPatch).not.toHaveBeenCalled();

    edit(inheritedInputs[1]!, "custom");
    expect(onPatch).toHaveBeenCalledWith(["settings"], ["a", "custom"]);
  });

  it("authors a nested inherited array item without dropping sibling defaults", async () => {
    const untouched = entry("beta", "two", "keep-two");
    const itemSchema = object({
      name: string,
      details: object({ label: { ...string, title: "Label" }, note: string }),
    });
    const { container, onPatch } = fixture(
      array(itemSchema, [entry("alpha", "one", "keep-one"), untouched]),
      undefined,
    );
    await expandConfigObjects(container);

    const labels = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[aria-label='Label']"),
    );
    expect(labels).toHaveLength(2);
    edit(labels[0]!, "changed", false);

    expect(onPatch).toHaveBeenCalledExactlyOnceWith(
      ["settings"],
      [entry("alpha", "changed", "keep-one"), entry("beta", "two", "keep-two")],
    );
  });

  it.each([
    [
      object({ apiKey: string }, { default: { apiKey: "default-secret" } }),
      { apiKey: "authored-secret" },
      "default-secret",
    ],
    [array(string, ["default-token"]), ["authored-token"], "default-token"],
  ] satisfies Array<[Options["schema"], unknown, string]>)(
    "conceals sensitive collection defaults: %s",
    (schema, value, secret) => {
      const { container } = fixture(schema, value, {
        path: ["settings", "sensitive"],
        hints: { "settings.sensitive": { sensitive: true } },
        revealSensitive: false,
      });
      expect(container.textContent).not.toContain(secret);
    },
  );

  it("keeps optional object children inherited until edited", () => {
    const onRemove = vi.fn();
    const schema = object({
      profile: object(
        { enabled: { type: "boolean", title: "Enabled" }, mode: { ...string, title: "Mode" } },
        { title: "Profile", default: { enabled: true, mode: "balanced" } },
      ),
      sibling: { ...string, title: "Sibling" },
    });
    const { container, update, onPatch } = fixture(
      schema,
      { profile: { enabled: false, mode: "custom" }, sibling: "preserved" },
      { onRemove },
    );

    const profile = findText(container, "details", "Profile");
    expect(profile.textContent).not.toContain('{"enabled":true,"mode":"balanced"}');
    expect(onPatch).not.toHaveBeenCalled();

    update({ sibling: "preserved" });

    const inheritedProfile = findText(container, "details", "Profile");
    expect(inheritedProfile.textContent).not.toContain('{"enabled":true,"mode":"balanced"}');
    const modeRow = findText(inheritedProfile, ".settings-row", "Mode");
    expect(inheritedProfile.textContent).not.toContain("Using default:");
    expect(input(modeRow).placeholder).toBe("Default: balanced");
    expect(onRemove).not.toHaveBeenCalled();

    edit(input(modeRow), "custom");
    expect(onPatch).toHaveBeenCalledWith(["settings", "profile"], {
      enabled: true,
      mode: "custom",
    });
  });
});
