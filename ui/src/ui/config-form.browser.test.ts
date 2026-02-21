import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { analyzeConfigSchema, renderConfigForm } from "./views/config-form.ts";

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
    bind: {
      anyOf: [{ const: "auto" }, { const: "lan" }, { const: "tailnet" }, { const: "loopback" }],
    },
  },
};

describe("config form renderer", () => {
  it("renders inputs and patches values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { label: "Gateway Token", sensitive: true },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        onPatch,
      }),
      container,
    );

    const tokenInput: HTMLInputElement | null = container.querySelector("input[type='password']");
    expect(tokenInput).not.toBeNull();
    if (!tokenInput) {
      return;
    }
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    ).find((btn) => btn.textContent?.trim() === "token");
    expect(tokenButton).not.toBeUndefined();
    tokenButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox: HTMLInputElement | null = container.querySelector("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    if (!checkbox) {
      return;
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);
  });

  it("adds and removes array entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { allowFrom: ["+1"] },
        onPatch,
      }),
      container,
    );

    const addButton = container.querySelector(".cfg-array__add");
    expect(addButton).not.toBeUndefined();
    addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = container.querySelector(".cfg-array__item-remove");
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);
  });

  it("renders union literals as select options", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { bind: "auto" },
        onPatch,
      }),
      container,
    );

    const tailnetButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    ).find((btn) => btn.textContent?.trim() === "tailnet");
    expect(tailnetButton).not.toBeUndefined();
    tailnetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("renders map fields from additionalProperties", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        slack: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { slack: { channelA: "ok" } },
        onPatch,
      }),
      container,
    );

    const removeButton = container.querySelector(".cfg-map__item-remove");
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["slack"], {});
  });

  it("supports wildcard uiHints for map entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          properties: {
            entries: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "plugins.entries.*.enabled": { label: "Plugin Enabled" },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: { plugins: { entries: { "voice-call": { enabled: true } } } },
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Plugin Enabled");
  });

  it("flags unsupported unions", () => {
    const schema = {
      type: "object",
      properties: {
        mixed: {
          anyOf: [{ type: "string" }, { type: "object", properties: {} }],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toContain("mixed");
  });

  it("supports nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("note");
  });

  it("ignores untyped additionalProperties schemas", () => {
    const schema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
          },
          additionalProperties: {},
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("channels");
  });

  it("flags additionalProperties true", () => {
    const schema = {
      type: "object",
      properties: {
        extra: {
          type: "object",
          additionalProperties: true,
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toContain("extra");
  });

  it("does not flag array parent as unsupported when only nested children are unsupported", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              complex: {
                anyOf: [{ type: "string" }, { type: "object", properties: {} }],
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);

    // The array parent should NOT be unsupported
    expect(analysis.unsupportedPaths).not.toContain("tags");

    // The nested unsupported field should be flagged — arrays use the parent
    // path directly (no "*") because pathKey strips numeric indices
    expect(analysis.unsupportedPaths).toContain("tags.complex");

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { tags: [{ label: "hello", complex: "world" }] },
        onPatch,
      }),
      container,
    );

    // The array section should render, not show "Unsupported schema node"
    expect(container.textContent).toContain("Tags");
    expect(container.textContent).toContain("1 item");

    // The unsupported nested field should show the error
    expect(container.textContent).toContain("Unsupported schema node");
  });

  it("does not flag map parent as unsupported when only nested children are unsupported", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              name: { type: "string" },
              advanced: {
                anyOf: [{ type: "string" }, { type: "object", properties: {} }],
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);

    // The parent path should NOT be unsupported
    expect(analysis.unsupportedPaths).not.toContain("accounts");

    // The nested unsupported field should be flagged with wildcard path
    expect(analysis.unsupportedPaths).toContain("accounts.*.advanced");

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { accounts: { default: { name: "main", advanced: "test" } } },
        onPatch,
      }),
      container,
    );

    // The accounts section should render, not show "Unsupported schema node"
    expect(container.textContent).toContain("Accounts");
    expect(container.textContent).toContain("Name");

    // The unsupported nested field should show the error
    expect(container.textContent).toContain("Unsupported schema node");
  });
});
