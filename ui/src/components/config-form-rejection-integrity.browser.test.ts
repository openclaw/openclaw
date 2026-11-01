import { describe, expect, it, vi } from "vitest";
import {
  expectElement,
  connectionSchemaFixture,
  renderObjectFixture,
  renderArrayFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";

const errorSelector = ".cfg-structured-draft__error [role='alert']";

function field(root: ParentNode, name: string) {
  return expectElement(root.querySelector<HTMLInputElement>(`input[aria-label='${name}']`), name);
}

function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string, type = "input") {
  input.value = value;
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

function add(root: ParentNode, label = "Add") {
  expectElement(
    Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === label,
    ),
    label,
  ).click();
}

describe("config form rejection integrity", () => {
  it.each([
    {
      kind: "array",
      items: { type: "array", items: { type: "string" } },
      initial: [[""], []],
      path: "groups",
      index: 2,
      addLabel: "Add",
      key: null,
      value: "x",
      expected: [[""], ["x"]],
    },
    {
      kind: "map",
      items: { type: "object", additionalProperties: { type: "object" } },
      initial: [{ "custom-1": {} }, {}],
      path: "entries",
      index: 1,
      addLabel: "Add Entry",
      key: "custom-2",
      value: "{}",
      expected: [{ "custom-1": {} }, { "custom-2": {} }],
    },
  ])("opens the $kind draft when a parent rejects the automatic entry", (testCase) => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    renderArrayFixture(container, {
      schema: {
        type: "array",
        uniqueItems: true,
        items: testCase.items,
      },
      value: testCase.initial,
      path: [testCase.path],
      onPatch,
    });

    const collection = expectElement(
      container.querySelectorAll<HTMLElement>(`.cfg-${testCase.kind}`)[testCase.index],
      `second auto-default ${testCase.kind}`,
    );
    const draft = expectElement(
      collection.querySelector("openclaw-config-form-collection-draft"),
      `second auto-default ${testCase.kind} draft`,
    );
    flush();
    add(collection, testCase.addLabel);
    flush();
    expect(draft.querySelector(".cfg-collection-draft")).not.toBeNull();

    if (testCase.key) {
      const key = expectElement(
        draft.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
        "map fallback draft key",
      );
      edit(key, testCase.key);
    }
    const value = expectElement(
      draft.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-collection-draft-value]"),
      `${testCase.kind} fallback draft value`,
    );
    edit(value, testCase.value);
    flush();
    add(draft, testCase.addLabel);
    expect(onPatch).toHaveBeenCalledWith([testCase.path], testCase.expected);
    container.remove();
  });

  it.each([true, false])(
    "preserves an optional object draft until valid, with commit accepted=%s",
    (accepted) => {
      const container = document.createElement("div");
      document.body.append(container);
      let currentValue: Record<string, unknown> = {};
      const onPatch = vi.fn((_path: Array<string | number>, value: unknown) => {
        if (!accepted) {
          return false;
        }
        currentValue = { ...currentValue, connection: value };
        renderValue();
        return true;
      });
      const schema = {
        type: "object",
        properties: {
          connection: connectionSchemaFixture(),
        },
      };
      const renderValue = () => {
        renderObjectFixture(container, {
          schema,
          value: currentValue,
          path: ["settings"],
          onPatch,
        });
      };

      renderValue();
      const draft = expectElement(
        container.querySelector<HTMLElement>("openclaw-config-form-structured-draft"),
        "optional object draft",
      );
      flush();
      edit(field(draft, "Host"), "gateway.local");
      flush();
      expect(onPatch).not.toHaveBeenCalled();

      renderValue();
      flush();
      expect(field(draft, "Host").value).toBe("gateway.local");
      edit(field(draft, "Port"), "18789");

      expect(onPatch).toHaveBeenCalledTimes(1);
      expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
        host: "gateway.local",
        port: 18789,
      });
      if (accepted) {
        expect(currentValue).toEqual({ connection: { host: "gateway.local", port: 18789 } });
        expect(container.querySelector("openclaw-config-form-structured-draft")).toBeNull();
      } else {
        flush();
        expect(field(draft, "Host").value).toBe("gateway.local");
        expect(field(draft, "Port").value).toBe("18789");
        expect(draft.querySelector(errorSelector)?.textContent).toContain("draft is still here");
        renderValue();
        flush();
        expect(field(draft, "Host").value).toBe("gateway.local");
        expect(draft.querySelector(errorSelector)?.textContent).toContain("draft is still here");
      }
      container.remove();
    },
  );

  it("constructs an optional large-minimum array without leaking partial values", () => {
    const onPatch = vi.fn((_path: Array<string | number>, _value: unknown) => false);
    const container = document.createElement("div");
    document.body.append(container);
    const schema = {
      type: "object",
      properties: {
        codes: {
          type: "array",
          minItems: 101,
          maxItems: 101,
          items: { type: "string" },
        },
      },
    };
    const renderValue = () => {
      renderObjectFixture(container, {
        schema,
        value: {},
        path: ["settings"],
        onPatch,
      });
    };

    renderValue();
    const draft = expectElement(
      container.querySelector<HTMLElement>("openclaw-config-form-structured-draft"),
      "large-minimum array draft",
    );
    flush();
    add(draft);
    flush();
    expect(onPatch).not.toHaveBeenCalled();
    expect(draft.textContent).toContain("1 item");

    renderValue();
    flush();
    expect(draft.textContent).toContain("1 item");

    add(draft);
    flush();
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [path, value] = onPatch.mock.calls[0] ?? [];
    expect(path).toEqual(["settings", "codes"]);
    expect(value).toEqual(Array.from({ length: 101 }, () => ""));
    expect(draft.textContent).toContain("101 items");
    expect(draft.querySelector(errorSelector)?.textContent).toContain("draft is still here");

    renderValue();
    flush();
    expect(draft.textContent).toContain("101 items");
    expect(draft.querySelector(errorSelector)?.textContent).toContain("draft is still here");
    container.remove();
  });
});
