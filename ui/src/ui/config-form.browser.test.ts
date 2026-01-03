import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import { renderConfigForm } from "./views/config-form";

const rootSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    allowFrom: {
      type: "array",
      items: { type: "string" },
    },
    mode: {
      type: "string",
      enum: ["off", "token"],
    },
    enabled: {
      type: "boolean",
    },
  },
};

describe("config form renderer", () => {
  it("renders inputs and patches values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: rootSchema,
        uiHints: {
          "gateway.auth.token": { label: "Gateway Token", sensitive: true },
        },
        value: {},
        onPatch,
      }),
      container,
    );

    const tokenInput = container.querySelector(
      "input[type='password']",
    ) as HTMLInputElement | null;
    expect(tokenInput).not.toBeNull();
    if (!tokenInput) return;
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(
      ["gateway", "auth", "token"],
      "abc123",
    );

    const select = container.querySelector("select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    if (!select) return;
    select.value = "token";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox = container.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    if (!checkbox) return;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);
  });

  it("adds and removes array entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: rootSchema,
        uiHints: {},
        value: { allowFrom: ["+1"] },
        onPatch,
      }),
      container,
    );

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Add",
    );
    expect(addButton).not.toBeUndefined();
    addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Remove",
    );
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);
  });
});
