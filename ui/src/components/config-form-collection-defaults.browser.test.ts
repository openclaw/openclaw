import { describe, expect, it, vi } from "vitest";
import {
  renderNodeFixture,
  renderArrayFixture,
  renderObjectFixture,
} from "../test-helpers/config-form-fixtures.tsx";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element, label).toBeInstanceOf(Element);
  return element!;
}

function fixture(render: typeof renderNodeFixture, options: Parameters<typeof render>[1]) {
  const container = document.createElement("div");
  const update = (value: typeof options.value) => render(container, { ...options, value });
  update(options.value);
  return { container, update };
}
const input = (root: ParentNode, label = "input") =>
  expectElement(root.querySelector<HTMLInputElement>("input"), label);
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
const entry = (name: string, label: string, note: string) => ({
  name,
  details: { label, note },
});

describe("config form collection defaults", () => {
  it("shows and clears optional JSON defaults without authoring the inherited value", () => {
    const onPatch = vi.fn();
    const { container, update } = fixture(renderNodeFixture, {
      schema: { anyOf: [{ type: "object" }, { type: "array" }], default: { mode: "balanced" } },
      value: { mode: "custom" },
      path: ["payload"],
      onPatch,
    });

    expect(container.textContent).toContain('Default: {"mode":"balanced"}');
    const textarea = expectElement(
      container.querySelector<HTMLTextAreaElement>("textarea"),
      "explicit JSON",
    );
    expect(textarea.value).toBe('{\n  "mode": "custom"\n}');
    textarea.value = "";
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["payload"], undefined);

    onPatch.mockClear();
    update(undefined);

    expect(container.textContent).not.toContain("Using default:");
    expect(container.querySelector(".settings-row__desc")).toBeNull();
    expect(
      expectElement(container.querySelector<HTMLTextAreaElement>("textarea"), "inherited JSON")
        .value,
    ).toBe('{\n  "mode": "balanced"\n}');
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("shows optional array defaults and authors inherited items without dropping siblings", () => {
    const onPatch = vi.fn(() => false);
    const { container, update } = fixture(renderArrayFixture, {
      schema: { type: "array", items: string, default: ["a", "b"] },
      value: ["custom"],
      path: ["values"],
      onPatch,
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
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "custom"]);
  });

  it("authors a nested inherited array item without dropping sibling defaults", () => {
    const onPatch = vi.fn();
    const untouched = entry("beta", "two", "keep-two");
    const { container } = fixture(renderArrayFixture, {
      schema: {
        type: "array",
        default: [entry("alpha", "one", "keep-one"), untouched],
        items: {
          type: "object",
          properties: {
            name: string,
            details: {
              type: "object",
              properties: { label: { ...string, title: "Label" }, note: string },
            },
          },
        },
      },
      value: undefined,
      path: ["entries"],
      onPatch,
    });

    const labels = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[aria-label='Label']"),
    );
    expect(labels).toHaveLength(2);
    edit(labels[0]!, "changed", false);

    expect(onPatch).toHaveBeenCalledExactlyOnceWith(
      ["entries"],
      [entry("alpha", "changed", "keep-one"), entry("beta", "two", "keep-two")],
    );
  });

  it.each([
    {
      render: renderObjectFixture,
      schema: {
        type: "object" as const,
        title: "Profile",
        default: { apiKey: "default-secret" },
        properties: { apiKey: string },
      },
      value: { apiKey: "authored-secret" },
      secret: "default-secret",
    },
    {
      render: renderArrayFixture,
      schema: {
        type: "array" as const,
        title: "Tokens",
        items: string,
        default: ["default-token"],
      },
      value: ["authored-token"],
      secret: "default-token",
    },
  ])(
    "conceals sensitive collection defaults: $schema.title",
    ({ render, schema, value, secret }) => {
      const { container } = fixture(render, {
        schema,
        value,
        path: ["settings", "sensitive"],
        hints: { "settings.sensitive": { sensitive: true } },
        revealSensitive: false,
        onPatch: vi.fn(),
      });
      expect(container.textContent).not.toContain(secret);
    },
  );

  it("keeps optional object children inherited until edited", () => {
    const onPatch = vi.fn();
    const onRemove = vi.fn();
    const { container, update } = fixture(renderObjectFixture, {
      schema: {
        type: "object",
        properties: {
          profile: {
            type: "object",
            title: "Profile",
            default: { enabled: true, mode: "balanced" },
            properties: {
              enabled: { type: "boolean", title: "Enabled" },
              mode: { ...string, title: "Mode" },
            },
          },
          sibling: { ...string, title: "Sibling" },
        },
      },
      value: {
        profile: { enabled: false, mode: "custom" },
        sibling: "preserved",
      },
      path: ["settings"],
      onPatch,
      onRemove,
    });

    const profile = findText(container, "details", "Profile");
    expect(profile.textContent).not.toContain('{"enabled":true,"mode":"balanced"}');
    expect(onPatch).not.toHaveBeenCalled();

    update({ sibling: "preserved" });

    const inheritedProfile = findText(container, "details", "Profile");
    expect(inheritedProfile.textContent).not.toContain('{"enabled":true,"mode":"balanced"}');
    const enabledRow = findText(inheritedProfile, ".settings-row", "Enabled");
    const modeRow = findText(inheritedProfile, ".settings-row", "Mode");
    expect(enabledRow.textContent).not.toContain("Using default:");
    expect(modeRow.textContent).not.toContain("Using default:");
    expect(input(modeRow).placeholder).toBe("Default: balanced");
    expect(onRemove).not.toHaveBeenCalled();

    edit(input(modeRow), "custom");
    expect(onPatch).toHaveBeenCalledWith(["settings", "profile"], {
      enabled: true,
      mode: "custom",
    });
  });
});
