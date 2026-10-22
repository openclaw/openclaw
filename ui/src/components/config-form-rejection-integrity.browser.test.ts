import { describe, expect, it, vi } from "vitest";
// Control UI tests cover nested config edit rejection and draft preservation.
import { renderObjectFixture, renderArrayFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
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
    expectElement(
      Array.from(collection.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === testCase.addLabel,
      ),
      `second auto-default ${testCase.kind} add`,
    ).click();
    flush();
    expect(draft.querySelector(".cfg-collection-draft")).not.toBeNull();

    if (testCase.key) {
      const key = expectElement(
        draft.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
        "map fallback draft key",
      );
      key.value = testCase.key;
      key.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const value = expectElement(
      draft.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-collection-draft-value]"),
      `${testCase.kind} fallback draft value`,
    );
    value.value = testCase.value;
    value.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expectElement(
      Array.from(draft.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === testCase.addLabel,
      ),
      `${testCase.kind} fallback draft commit`,
    ).click();
    expect(onPatch).toHaveBeenCalledWith([testCase.path], testCase.expected);
    container.remove();
  });

  it("blocks renaming a map key whose value is still a redacted secret", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderObjectFixture(container, {
      schema: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      value: { primary: "__OPENCLAW_REDACTED__", plain: "visible" },
      path: ["secrets"],
      onPatch,
    });

    const redactedKey = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Key: primary']"),
      "redacted map key",
    );
    redactedKey.value = "renamed";
    redactedKey.dispatchEvent(new Event("change", { bubbles: true }));

    // Moving the sentinel to a new key can only produce an unsavable draft or,
    // folded with a delete, silently bind the wrong stored credential.
    expect(onPatch).not.toHaveBeenCalled();
    expect(redactedKey.value).toBe("primary");

    const plainKey = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Key: plain']"),
      "plain map key",
    );
    plainKey.value = "renamed";
    plainKey.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["secrets"], {
      primary: "__OPENCLAW_REDACTED__",
      renamed: "visible",
    });
    container.remove();
  });

  it("commits an optional object only after all required children are valid", () => {
    const container = document.createElement("div");
    document.body.append(container);
    let currentValue: Record<string, unknown> = {};
    const onPatch = vi.fn((path: Array<string | number>, value: unknown) => {
      currentValue = { ...currentValue, connection: value };
      renderValue();
      return true;
    });
    const schema = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          required: ["host", "port"],
          properties: {
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1 },
          },
        },
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
    const host = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
      "optional host",
    );
    host.value = "gateway.local";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(onPatch).not.toHaveBeenCalled();

    renderValue();
    flush();
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
        "preserved optional host",
      ).value,
    ).toBe("gateway.local");

    const port = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "optional port",
    );
    port.value = "18789";
    port.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
      host: "gateway.local",
      port: 18789,
    });
    expect(currentValue).toEqual({
      connection: { host: "gateway.local", port: 18789 },
    });
    expect(container.querySelector("openclaw-config-form-structured-draft")).toBeNull();
    container.remove();
  });

  it("retains a complete optional object draft when its atomic commit is rejected", () => {
    const onPatch = vi.fn(() => false);
    const container = document.createElement("div");
    document.body.append(container);
    const schema = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          required: ["host", "port"],
          properties: {
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1 },
          },
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
      "rejected optional object draft",
    );
    flush();
    const host = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
      "rejected optional host",
    );
    host.value = "gateway.local";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const port = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "rejected optional port",
    );
    port.value = "18789";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    flush();

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
      host: "gateway.local",
      port: 18789,
    });
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
        "retained rejected host",
      ).value,
    ).toBe("gateway.local");
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Port']"),
        "retained rejected port",
      ).value,
    ).toBe("18789");
    expect(
      draft.querySelector<HTMLElement>(".cfg-structured-draft__error [role='alert']")?.textContent,
    ).toContain("draft is still here");

    renderValue();
    flush();
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
        "rerendered rejected host",
      ).value,
    ).toBe("gateway.local");
    expect(
      draft.querySelector<HTMLElement>(".cfg-structured-draft__error [role='alert']")?.textContent,
    ).toContain("draft is still here");
    container.remove();
  });

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
    const add = (draft: HTMLElement) =>
      expectElement(
        Array.from(draft.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Add",
        ),
        "large-minimum array add",
      );

    renderValue();
    const draft = expectElement(
      container.querySelector<HTMLElement>("openclaw-config-form-structured-draft"),
      "large-minimum array draft",
    );
    flush();
    add(draft).click();
    flush();
    expect(onPatch).not.toHaveBeenCalled();
    expect(draft.textContent).toContain("1 item");

    renderValue();
    flush();
    expect(draft.textContent).toContain("1 item");

    add(draft).click();
    flush();
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [path, value] = onPatch.mock.calls[0] ?? [];
    expect(path).toEqual(["settings", "codes"]);
    expect(value).toEqual(Array.from({ length: 101 }, () => ""));
    expect(draft.textContent).toContain("101 items");
    expect(
      draft.querySelector<HTMLElement>(".cfg-structured-draft__error [role='alert']")?.textContent,
    ).toContain("draft is still here");

    renderValue();
    flush();
    expect(draft.textContent).toContain("101 items");
    expect(
      draft.querySelector<HTMLElement>(".cfg-structured-draft__error [role='alert']")?.textContent,
    ).toContain("draft is still here");
    container.remove();
  });
});
