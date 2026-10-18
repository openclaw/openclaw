import { describe, expect, it, vi } from "vitest";
import { renderObjectFixture, renderArrayFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { expectElement, query, edit, objectSchema } from "./config-form-integrity.test-support.ts";
import type { JsonSchema } from "./config-form.shared.ts";

function click(parent: ParentNode, label: string) {
  expectElement(
    [...parent.querySelectorAll("button")].find((button) => button.textContent?.trim() === label),
    label,
  ).click();
}

const connection: JsonSchema = {
  type: "object",
  required: ["host", "port"],
  properties: {
    host: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1 },
  },
};

function optionalDraft(field: string, schema: JsonSchema, accept = false) {
  const container = document.createElement("div");
  document.body.append(container);
  let currentValue: Record<string, unknown> = {};
  const onPatch = vi.fn((_path: Array<string | number>, value: unknown) => {
    if (accept) {
      currentValue = { ...currentValue, [field]: value };
      renderValue();
    }
    return accept;
  });
  const rootSchema = objectSchema({ [field]: schema });
  const renderValue = () =>
    renderObjectFixture(container, {
      schema: rootSchema,
      value: currentValue,
      path: ["settings"],
      onPatch,
    });
  renderValue();
  const draft = query<HTMLElement>(container, "openclaw-config-form-structured-draft");
  flush();
  return { container, draft, onPatch, renderValue, current: () => currentValue };
}

function expectRetainedError(draft: HTMLElement) {
  expect(draft.querySelector(".cfg-structured-draft__error [role='alert']")?.textContent).toContain(
    "draft is still here",
  );
}

describe("config form rejection integrity", () => {
  it.each(["array", "map"] as const)(
    "opens a %s draft when a parent rejects the automatic entry",
    (kind) => {
      const map = kind === "map";
      const path = [map ? "entries" : "groups"];
      const initial = map ? [{ "custom-1": {} }, {}] : [[""], []];
      const expected = map ? [{ "custom-1": {} }, { "custom-2": {} }] : [[""], ["x"]];
      const onPatch = vi.fn();
      const container = document.createElement("div");
      document.body.append(container);
      renderArrayFixture(container, {
        schema: {
          type: "array",
          uniqueItems: true,
          items: map
            ? { type: "object", additionalProperties: { type: "object" } }
            : { type: "array", items: { type: "string" } },
        },
        value: initial,
        path,
        onPatch,
      });
      const owner = expectElement(
        container.querySelectorAll(map ? ".cfg-map" : ".cfg-array")[map ? 1 : 2],
        "second collection",
      );
      const draft = query(owner, "openclaw-config-form-collection-draft");
      const label = map ? "Add Entry" : "Add";
      flush();
      click(owner, label);
      flush();
      expect(draft.querySelector(".cfg-collection-draft")).not.toBeNull();
      if (map) {
        edit(query<HTMLInputElement>(draft, "[data-collection-draft-key]"), "custom-2");
      }
      edit(
        query<HTMLInputElement | HTMLTextAreaElement>(draft, "[data-collection-draft-value]"),
        map ? "{}" : "x",
      );
      flush();
      click(draft, label);
      expect(onPatch).toHaveBeenCalledWith(path, expected);
      container.remove();
    },
  );

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
    const redactedKey = query<HTMLInputElement>(container, "input[aria-label='Key: primary']");
    redactedKey.value = "renamed";
    redactedKey.dispatchEvent(new Event("change", { bubbles: true }));
    // Moving the sentinel to a new key can only produce an unsavable draft or,
    // folded with a delete, silently bind the wrong stored credential.
    expect(onPatch).not.toHaveBeenCalled();
    expect(redactedKey.value).toBe("primary");
    const plainKey = query<HTMLInputElement>(container, "input[aria-label='Key: plain']");
    plainKey.value = "renamed";
    plainKey.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["secrets"], {
      primary: "__OPENCLAW_REDACTED__",
      renamed: "visible",
    });
    container.remove();
  });

  it("commits an optional object only after all required children are valid", () => {
    const { container, draft, onPatch, renderValue, current } = optionalDraft(
      "connection",
      connection,
      true,
    );
    const host = query<HTMLInputElement>(draft, "input[aria-label='Host']");
    edit(host, "gateway.local");
    flush();
    expect(onPatch).not.toHaveBeenCalled();
    renderValue();
    flush();
    expect(query<HTMLInputElement>(draft, "input[aria-label='Host']").value).toBe("gateway.local");
    const port = query<HTMLInputElement>(draft, "input[aria-label='Port']");
    edit(port, "18789");
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
      host: "gateway.local",
      port: 18789,
    });
    expect(current()).toEqual({
      connection: { host: "gateway.local", port: 18789 },
    });
    expect(container.querySelector("openclaw-config-form-structured-draft")).toBeNull();
    container.remove();
  });

  it("retains a complete optional object draft when its atomic commit is rejected", () => {
    const { container, draft, onPatch, renderValue } = optionalDraft("connection", connection);
    const host = query<HTMLInputElement>(draft, "input[aria-label='Host']");
    edit(host, "gateway.local");
    flush();
    const port = query<HTMLInputElement>(draft, "input[aria-label='Port']");
    edit(port, "18789");
    flush();
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
      host: "gateway.local",
      port: 18789,
    });
    expect(query<HTMLInputElement>(draft, "input[aria-label='Host']").value).toBe("gateway.local");
    expect(query<HTMLInputElement>(draft, "input[aria-label='Port']").value).toBe("18789");
    expectRetainedError(draft);
    renderValue();
    flush();
    expect(query<HTMLInputElement>(draft, "input[aria-label='Host']").value).toBe("gateway.local");
    expectRetainedError(draft);
    container.remove();
  });

  it("constructs an optional large-minimum array without leaking partial values", () => {
    const { container, draft, onPatch, renderValue } = optionalDraft("codes", {
      type: "array",
      minItems: 101,
      maxItems: 101,
      items: { type: "string" },
    });
    click(draft, "Add");
    flush();
    expect(onPatch).not.toHaveBeenCalled();
    expect(draft.textContent).toContain("1 item");
    renderValue();
    flush();
    expect(draft.textContent).toContain("1 item");
    click(draft, "Add");
    flush();
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [path, value] = onPatch.mock.calls[0] ?? [];
    expect(path).toEqual(["settings", "codes"]);
    expect(value).toEqual(Array.from({ length: 101 }, () => ""));
    expect(draft.textContent).toContain("101 items");
    expectRetainedError(draft);
    renderValue();
    flush();
    expect(draft.textContent).toContain("101 items");
    expectRetainedError(draft);
    container.remove();
  });
});
