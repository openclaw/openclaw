import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { PluginSettingsEditor } from "./settings-editor.ts";
import type { PluginSettingsEditorModel } from "./settings-model.ts";
import "../../styles.css";
import "../../styles/settings.css";

const prefix = "plugins.entries.fixture.config";
async function mount(overrides: Partial<PluginSettingsEditorModel> = {}) {
  const model: PluginSettingsEditorModel = {
    pluginId: "fixture",
    result: null,
    connected: true,
    configValue: { plugins: { entries: { fixture: { config: { enabled: true } } } } },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        storage: {
          type: "object",
          additionalProperties: false,
          default: { path: "original", mode: "keep" },
          properties: {
            path: { type: "string", title: "Path" },
            mode: { type: "string", title: "Mode" },
          },
        },
        timeout: { type: "integer", title: "Timeout", default: 30 },
      },
    },
    configHints: {
      [prefix]: {
        groups: [
          { id: "capture", title: "Capture", order: 20, properties: ["enabled"] },
          { id: "data", title: "Data storage", order: 10, properties: ["storage"] },
        ],
      },
    },
    configUnsupportedPaths: [],
    canEditConfig: true,
    configBusy: false,
    configSchemaLoading: false,
    configError: null,
    onConfigPatch: vi.fn(),
    onConfigRemove: vi.fn(),
    onConfigReadRetry: vi.fn(),
    onConfigWriteRetry: vi.fn(),
    backHref: "/settings/plugins/fixture",
    onBack: vi.fn(),
    ...overrides,
  };
  const editor = new PluginSettingsEditor();
  editor.model = model;
  document.body.append(editor);
  await editor.updateComplete;
  return { editor, model };
}
afterEach(() => document.body.replaceChildren());
describe("grouped plugin settings", () => {
  it("navigates authored sections without hiding settings and omits the rail for flat schemas", async () => {
    const { editor, model } = await mount();
    const links = [...editor.querySelectorAll<HTMLAnchorElement>(".plugin-editor__nav a")];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "Data storage",
      "Capture",
      "Other",
    ]);
    const target = editor.querySelector<HTMLElement>(links[1]!.getAttribute("href")!)!;
    const scroll = vi.spyOn(target, "scrollIntoView");
    links[1]!.click();
    expect(scroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target);
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(4);
    expect(editor.querySelector("h1")).toBeNull();
    editor.model = { ...model, configHints: {} };
    await editor.updateComplete;
    expect(editor.querySelector(".plugin-editor__nav")).toBeNull();
  });
  it("shows authored automatic numeric placeholders without persisting a made-up default", async () => {
    const { editor, model } = await mount({
      configHints: { [`${prefix}.timeout`]: { placeholder: "Automatic" } },
      configSchema: {
        type: "object",
        properties: { timeout: { type: "integer", title: "Timeout" } },
      },
    });
    const input = editor.querySelector<HTMLInputElement>('input[aria-label="Timeout"]')!;
    expect(input.placeholder).toBe("Automatic");
    expect(input.value).toBe("");
    input.focus();
    input.blur();
    expect(model.onConfigPatch).not.toHaveBeenCalled();
  });
  it("keeps a retired menu bound to the setting action that rendered it", async () => {
    const { editor, model } = await mount();
    const original = vi.fn();
    editor.onAskSetting = original;
    await editor.updateComplete;
    const menu = editor.querySelector('[data-setting="enabled"] wa-dropdown')!;
    const replacement = vi.fn();
    editor.onAskSetting = replacement;
    editor.model = {
      ...model,
      pluginId: "replacement",
      configHints: {},
      configSchema: { type: "object", properties: { limit: { type: "number" } } },
    };
    await editor.updateComplete;
    expect(menu.isConnected).toBe(false);
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "ask" } } }));
    expect(replacement).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: ["plugins", "entries", "fixture", "config", "enabled"] }),
    );
  });
  it("shows every group and remaining field once, with names instead of raw keys or counts", async () => {
    const { editor, model } = await mount();
    expect([...editor.querySelectorAll("h2")].map((e) => e.textContent?.trim())).toEqual([
      "Data storage",
      "Capture",
      "Other",
    ]);
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(4);
    const back = editor.querySelector<HTMLAnchorElement>(".plugins-settings-breadcrumb__parent")!;
    expect(back.getAttribute("href")).toBe("/settings/plugins/fixture");
    back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(model.onBack).toHaveBeenCalledOnce();
    expect(editor.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe("Settings");
    expect(editor.textContent).not.toContain(prefix);
    expect(editor.textContent).not.toMatch(/\d+ settings/);
  });
  it("edits an inherited nested value on blur without losing its sibling", async () => {
    const { editor, model } = await mount();
    const input = editor.querySelector<HTMLInputElement>('input[aria-label="Storage: Path"]')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("original");
    input.focus();
    input.value = "changed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(model.onConfigPatch).not.toHaveBeenCalled();
    input.blur();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "storage"],
      { path: "changed", mode: "keep" },
    );
  });
  it("searches authored group names across all fields", async () => {
    const { editor } = await mount();
    const search = editor.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search).not.toBeNull();
    search.value = "data storage";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await editor.updateComplete;
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(2);
    expect(editor.textContent).toContain("Storage: Path");
    expect(editor.textContent).not.toContain("Timeout");
  });
  it("finds editable descendants inside retained object settings", async () => {
    const { editor, model } = await mount({
      configHints: {},
      configValue: {
        plugins: { entries: { fixture: { config: { storage: { path: "original" } } } } },
      },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          storage: {
            type: "object",
            title: "Storage",
            properties: { path: { type: "string", title: "Directory" } },
          },
        },
      },
    });
    const search = editor.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "directory";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await editor.updateComplete;
    const input = editor.querySelector<HTMLInputElement>('input[aria-label="Directory"]');
    expect(input).not.toBeNull();
    input!.focus();
    input!.value = "changed";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.blur();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "storage", "path"],
      "changed",
    );
  });
  it("keeps object array inputs aligned beside removal and finds their descendants", async () => {
    const { editor, model } = await mount({
      configHints: {},
      configValue: {
        plugins: {
          entries: { fixture: { config: { targets: [{ path: "first", mode: "keep" }] } } },
        },
      },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          targets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", title: "Directory" },
                mode: { type: "string", title: "Mode" },
              },
            },
          },
        },
      },
    });
    editor.style.width = "1000px";
    const inputs = [...editor.querySelectorAll<HTMLInputElement>(".cfg-array__item input")];
    expect(inputs).toHaveLength(2);
    const bounds = inputs.map((input) => input.getBoundingClientRect());
    const remove = editor.querySelector<HTMLButtonElement>('button[aria-label="Remove item"]')!;
    const removeBounds = remove.getBoundingClientRect();
    expect(bounds[0]!.left).toBe(bounds[1]!.left);
    expect(bounds[1]!.top).toBeGreaterThan(bounds[0]!.bottom);
    expect(removeBounds.left).toBeGreaterThanOrEqual(bounds[0]!.right);
    expect(removeBounds.top).toBeLessThan(bounds[0]!.bottom);
    const search = editor.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "directory";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await editor.updateComplete;
    expect(editor.querySelectorAll(".cfg-array__item input")).toHaveLength(2);
    remove.click();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "targets"],
      [],
    );
  });
  it.each([
    { schema: { type: "string" }, value: REDACTED_SENTINEL, replacement: "replacement-key" },
    {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          provider: { type: "string" },
          id: { type: "string" },
        },
      },
      value: { source: "env", provider: "default", id: "SEARCH_API_KEY" },
      replacement: { source: "file", provider: "team", id: "/key" },
    },
  ])(
    "keeps a configured nested $schema.type credential as one specialized editor",
    async ({ schema, value, replacement }) => {
      const { editor, model } = await mount({
        configHints: { [`${prefix}.search.apiKey`]: { sensitive: true } },
        configValue: {
          plugins: { entries: { fixture: { config: { search: { apiKey: value, mode: "web" } } } } },
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            search: {
              type: "object",
              additionalProperties: false,
              properties: {
                apiKey: { ...schema, title: "API key" },
                mode: { type: "string", title: "Mode" },
              },
            },
          },
        },
      });
      editor.renderCredential = (field) =>
        field.path.at(-1) === "apiKey"
          ? html`<button @click=${() => field.onPatch(field.path, replacement)}>
              Replace credential
            </button>`
          : undefined;
      await editor.updateComplete;
      const credential = [...editor.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Replace credential",
      );
      expect(credential).toBeDefined();
      expect(editor.textContent).not.toContain(REDACTED_SENTINEL);
      expect(editor.querySelector('input[aria-label="Search: Mode"]')).not.toBeNull();
      credential!.click();
      expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
        ["plugins", "entries", "fixture", "config", "search", "apiKey"],
        replacement,
      );
    },
  );
  it("activates a checkbox row once and keeps read-only rows inert", async () => {
    const { editor, model } = await mount();
    const row = editor.querySelector<HTMLElement>('[data-setting="enabled"]')!;
    expect(row).not.toBeNull();
    row.click();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "enabled"],
      false,
    );
    vi.mocked(model.onConfigPatch).mockClear();
    editor.model = { ...model, canEditConfig: false };
    await editor.updateComplete;
    row.click();
    expect(model.onConfigPatch).not.toHaveBeenCalled();
  });
  it("toggles the checkbox once without toggling from selected text or the actions menu", async () => {
    const { editor, model } = await mount();
    const row = editor.querySelector<HTMLElement>('[data-setting="enabled"]')!;
    const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(input).not.toBeNull();
    input.click();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "enabled"],
      false,
    );
    vi.mocked(model.onConfigPatch).mockClear();
    const range = document.createRange();
    range.selectNodeContents(row.querySelector(".plugin-editor__title")!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    expect(getSelection()!.toString()).toBe("Enabled");
    row.click();
    expect(model.onConfigPatch).not.toHaveBeenCalled();
    getSelection()!.removeAllRanges();
    row.querySelector<HTMLButtonElement>('button[slot="trigger"]')!.click();
    expect(model.onConfigPatch).not.toHaveBeenCalled();
  });
  it("retains empty object fields instead of silently dropping them", async () => {
    const { editor } = await mount({
      configHints: {},
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          empty: {
            type: "object",
            title: "Empty object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
    });
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(1);
    expect(editor.textContent).toContain("Empty object");
  });
  it("keeps inherited values unset when focus leaves an unchanged field", async () => {
    const { editor, model } = await mount();
    const input = editor.querySelector<HTMLInputElement>('input[aria-label="Storage: Path"]')!;
    input.focus();
    input.blur();
    const number = editor.querySelector<HTMLInputElement>('input[aria-label="Timeout"]')!;
    expect(number.value).toBe("30");
    number.focus();
    number.blur();
    expect(model.onConfigPatch).not.toHaveBeenCalled();
  });
  it("edits inherited array items on blur and preserves sibling items", async () => {
    const { editor, model } = await mount({
      configHints: {},
      configValue: { plugins: { entries: { fixture: { config: {} } } } },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tags: {
            type: "array",
            title: "Tags",
            default: ["alpha", "beta"],
            items: { type: "string" },
          },
        },
      },
    });
    const row = editor.querySelector<HTMLElement>('[data-setting="tags"]')!;
    const inputs = [...row.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs.map((input) => input.value)).toEqual(["alpha", "beta"]);
    expect(row.textContent).not.toContain("2 items");
    inputs[1]!.focus();
    inputs[1]!.value = "edited";
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(model.onConfigPatch).not.toHaveBeenCalled();
    inputs[1]!.blur();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "tags"],
      ["alpha", "edited"],
    );
  });
  it("preserves literal dotted property identity and the complete flat form", async () => {
    const { editor, model } = await mount({
      configHints: {},
      configValue: { plugins: { entries: { fixture: { config: { "model.name": "first" } } } } },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          "model.name": { type: "string", title: "Model name" },
          empty: { type: "integer" },
        },
      },
    });
    expect(editor.querySelectorAll("[data-setting]")).toHaveLength(2);
    expect(editor.querySelectorAll("h2")).toHaveLength(0);
    const input = editor.querySelector<HTMLInputElement>('input[aria-label="Model name"]')!;
    input.focus();
    input.value = "second";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
      ["plugins", "entries", "fixture", "config", "model.name"],
      "second",
    );
  });
});

describe("grouped editor field discovery", () => {
  it("associates visible field instructions with native controls", async () => {
    const { editor } = await mount({
      configHints: {
        [`${prefix}.enabled`]: { help: "Capture messages for this plugin." },
        [`${prefix}.timeout`]: { help: "Wait this many seconds." },
        [`${prefix}.storage.path`]: { help: "Choose a local directory." },
      },
    });
    for (const name of ["Enabled", "Timeout", "Storage: Path"]) {
      const input = editor.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
      const ids = input.getAttribute("aria-describedby")?.trim().split(/\s+/u) ?? [];
      const instructions = input
        .closest(".plugin-editor__row")
        ?.querySelector(".plugin-editor__copy p");
      expect(instructions?.textContent?.trim()).toBeTruthy();
      expect(ids).toContain(instructions?.id);
      const descriptions = ids.map((id) => document.getElementById(id));
      expect(descriptions).toContain(instructions);
      expect(descriptions).not.toContain(null);
    }
  });

  it("filters dynamic root settings and shows the unmatched search state", async () => {
    const { editor } = await mount({
      configSchema: { type: "object", properties: {}, additionalProperties: { type: "string" } },
      configHints: {},
      configValue: {
        plugins: { entries: { fixture: { config: { alpha: "first", beta: "second" } } } },
      },
    });
    const search = editor.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await editor.updateComplete;
    expect(editor.querySelector('input[aria-label="Key: alpha"]')).not.toBeNull();
    expect(editor.querySelector('input[aria-label="Key: beta"]')).toBeNull();
    search.value = "does-not-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await editor.updateComplete;
    expect(editor.querySelector(".cfg-map")).toBeNull();
    expect(editor.querySelector(".plugin-editor__empty")?.textContent).toContain(
      "No matching settings.",
    );
  });
});

describe("plugin map layout", () => {
  it.each([1728, 390])("keeps map labels, keys, and values usable at %s pixels", async (width) => {
    await page.viewport(width, 913);
    const { editor, model } = await mount({
      configHints: {},
      configValue: { plugins: { entries: { fixture: { config: { populated: { first: 15 } } } } } },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          empty: {
            type: "object",
            title: "Empty overrides",
            additionalProperties: { type: "number" },
          },
          populated: {
            type: "object",
            title: "Populated overrides",
            additionalProperties: { type: "number" },
          },
        },
      },
    });
    editor.style.width = width > 768 ? "880px" : "100%";
    try {
      for (const title of editor.querySelectorAll<HTMLElement>(
        ".cfg-map > .settings-row .settings-row__title",
      )) {
        const bounds = title.getBoundingClientRect();
        expect(bounds.width).toBeGreaterThan(90);
        expect(bounds.height).toBeLessThanOrEqual(
          Number.parseFloat(getComputedStyle(title).lineHeight) * 2,
        );
      }
      for (const add of editor.querySelectorAll<HTMLButtonElement>(
        ".cfg-map > .settings-row button",
      )) {
        const bounds = add.getBoundingClientRect();
        const mapBounds = add.closest(".cfg-map")!.getBoundingClientRect();
        expect(bounds.width).toBeGreaterThan(60);
        expect(bounds.height).toBeLessThan(48);
        expect(bounds.right).toBeLessThanOrEqual(mapBounds.right);
      }
      const key = editor.querySelector<HTMLInputElement>('input[aria-label="Key: first"]')!;
      expect(key.getBoundingClientRect().width).toBeGreaterThan(100);
      const value = editor.querySelector<HTMLInputElement>(
        '[data-setting="populated"] input[type="number"]',
      )!;
      expect(value.getBoundingClientRect().width).toBeGreaterThan(100);
      expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
      editor
        .querySelector<HTMLButtonElement>(
          '[data-setting="populated"] button[aria-label="Remove entry"]',
        )!
        .click();
      expect(model.onConfigPatch).toHaveBeenCalledExactlyOnceWith(
        ["plugins", "entries", "fixture", "config", "populated"],
        {},
      );
    } finally {
      await page.viewport(800, 600);
    }
  });
});
