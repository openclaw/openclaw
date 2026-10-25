import { describe, expect, it, vi } from "vitest";
// Control UI tests cover collection default provenance and editing behavior.
import {
  renderNodeFixture,
  renderArrayFixture,
  renderObjectFixture,
} from "../test-helpers/config-form-fixtures.tsx";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
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

describe("config form collection defaults", () => {
  it("shows and clears optional JSON defaults without authoring the inherited value", () => {
    const onPatch = vi.fn();
    const schema = {
      anyOf: [{ type: "object" as const }, { type: "array" as const }],
      default: { mode: "balanced" },
    };

    const { container, update } = fixture(renderNodeFixture, {
      schema,
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
    const schema = {
      type: "array" as const,
      items: { type: "string" as const },
      default: ["a", "b"],
    };

    const { container, update } = fixture(renderArrayFixture, {
      schema,
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
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      type: "array" as const,
      default: [
        { name: "alpha", details: { label: "one", note: "keep-one" } },
        { name: "beta", details: { label: "two", note: "keep-two" } },
      ],
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, title: "Name" },
          details: {
            type: "object" as const,
            title: "Details",
            properties: {
              label: { type: "string" as const, title: "Label" },
              note: { type: "string" as const, title: "Note" },
            },
          },
        },
      },
    };

    renderArrayFixture(container, {
      schema,
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
      [
        { name: "alpha", details: { label: "changed", note: "keep-one" } },
        { name: "beta", details: { label: "two", note: "keep-two" } },
      ],
    );
  });

  it("conceals sensitive collection defaults", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const hints = {
      "settings.profile": { sensitive: true },
      "settings.tokens": { sensitive: true },
    };

    renderObjectFixture(container, {
      schema: {
        type: "object",
        title: "Profile",
        default: { apiKey: "default-secret" },
        properties: { apiKey: { type: "string" } },
      },
      value: { apiKey: "authored-secret" },
      path: ["settings", "profile"],
      hints,
      revealSensitive: false,
      onPatch,
    });

    expect(container.textContent).not.toContain("default-secret");

    renderArrayFixture(container, {
      schema: {
        type: "array",
        title: "Tokens",
        items: { type: "string" },
        default: ["default-token"],
      },
      value: ["authored-token"],
      path: ["settings", "tokens"],
      hints,
      revealSensitive: false,
      onPatch,
    });

    expect(container.textContent).not.toContain("default-token");
  });

  it("keeps optional object children inherited until edited", () => {
    const onPatch = vi.fn();
    const onRemove = vi.fn();
    const schema = {
      type: "object" as const,
      properties: {
        profile: {
          type: "object" as const,
          title: "Profile",
          default: { enabled: true, mode: "balanced" },
          properties: {
            enabled: { type: "boolean" as const, title: "Enabled" },
            mode: { type: "string" as const, title: "Mode" },
          },
        },
        sibling: { type: "string" as const, title: "Sibling" },
      },
    };

    const { container, update } = fixture(renderObjectFixture, {
      schema,
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

    onRemove.mockClear();
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
