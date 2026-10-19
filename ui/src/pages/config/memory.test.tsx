/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { ConfigForm } from "../../components/config-form.render.tsx";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { memorySettingsSchema } from "./memory-schema.ts";
import { buildMemoryAddonRows, Memory, type MemoryCatalogState } from "./memory.tsx";

type MemoryViewProps = Parameters<typeof Memory>[0];
const addonLabels = [
  ["active-memory", "Active memory", "Recent context", "enabled"],
  ["memory-wiki", "Memory wiki", "Wiki pages", "disabled"],
] as const;
const emptyOutcomes = () => ({
  busy: new Set<string>(),
  errors: new Map<string, string>(),
  notices: new Map<string, { message: string }>(),
  refreshWarnings: new Map<string, string>(),
});

function createProps(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    activeTab: "settings",
    onTabChange: vi.fn(),
    engineOptions: [
      { id: "memory-core", label: "OpenClaw Memory", available: true },
      { id: "memory-lancedb", label: "Memory LanceDB", available: true },
    ],
    engineSelection: { kind: "default", pluginId: "memory-core" },
    engineState: "enabled",
    engineBusy: false,
    engineOutcome: null,
    onEngineChange: vi.fn(),
    addons: addonLabels.map(([id, label, description, state]) => ({
      id,
      label,
      description,
      state,
      busy: false,
      error: null,
      notice: null,
    })),
    canToggleAddons: true,
    onAddonChange: vi.fn(),
    pluginsHref: "/settings/plugins",
    memoryImportHref: "/memory-import",
    canImportMemory: true,
    overview: null,
    memories: null,
    dreams: null,
    editor: null,
    dreamingSettings: null,
    ...overrides,
  };
}

const objectSchema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});

function renderInto(overrides: Partial<MemoryViewProps> = {}): HTMLElement {
  const props = createProps(overrides);
  const { container } = mountSolid(() => <Memory {...props} />);
  flush();
  return container;
}

it("translates declared labels on each read without changing row order", async () => {
  const rows = () =>
    buildMemoryAddonRows({ kind: "loading" }, emptyOutcomes()).map((row) => [row.id, row.label]);
  const english = addonLabels.map(([id, label]) => [id, label]);
  try {
    await i18n.setLocale("en");
    expect(rows()).toEqual(english);
    await i18n.setLocale("fr");
    expect(rows()).toEqual([
      ["active-memory", "Mémoire active"],
      ["memory-wiki", "Wiki de mémoire"],
    ]);
    await i18n.setLocale("en");
    expect(rows()).toEqual(english);
  } finally {
    await i18n.setLocale("en");
  }
});

it.each([
  [{ kind: "loading" }, "loading"],
  [{ kind: "unavailable" }, "unknown"],
  [{ kind: "ready", plugins: [], mutationAllowed: false }, "unknown"],
] satisfies [MemoryCatalogState, string][])(
  "keeps bundled add-ons visible and ordered with a %j catalog",
  (catalog, expectedState) => {
    const rows = buildMemoryAddonRows(catalog, emptyOutcomes());
    expect(rows.map((row) => [row.id, row.label, row.description, row.state])).toEqual(
      addonLabels.map(([id, label]) => [id, label, id, expectedState]),
    );
  },
);

it("retains engine and add-on controls when their owner publishes new state", () => {
  const [props, setProps] = createSignal(createProps());
  const { container } = mountSolid(() => <Memory {...props()} />);
  flush();
  const engine = container.querySelector<HTMLInputElement>(
    'input[type="radio"][value="memory-core"]',
  );
  const addon = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect([engine, addon]).not.toContain(null);
  engine!.focus();

  setProps((current) => ({
    ...current,
    engineSelection: { kind: "pinned", pluginId: "memory-lancedb" },
    engineOutcome: { kind: "warning", message: "Refresh pending" },
    addons: current.addons.map((item) => ({ ...item, state: "disabled" })),
  }));
  flush();

  expect(container.querySelector('input[type="radio"][value="memory-core"]')).toBe(engine);
  expect(container.querySelector('input[type="checkbox"]')).toBe(addon);
  expect(document.activeElement).toBe(engine);
  expect(addon?.checked).toBe(false);
});

it("replaces the memory-import link with an admin-required note", () => {
  const container = renderInto({ canImportMemory: false });

  expect(container.querySelector('a[href="/memory-import"]')).toBeNull();
  expect(container.textContent).toContain("Memory import requires operator.admin access.");
});

it("keeps a configured missing engine selected and labels it unavailable", () => {
  const container = renderInto({
    engineOptions: [{ id: "retired-memory", label: "retired-memory", available: false }],
    engineSelection: { kind: "pinned", pluginId: "retired-memory" },
    engineState: "unknown",
  });

  const input = container.querySelector<HTMLInputElement>('input[value="retired-memory"]');
  expect(input?.closest(".settings-segmented__btn")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "retired-memory (Unavailable)",
  );
  expect(input?.checked).toBe(true);
});

it("shows the shared advanced disclosure only on Settings and reveals advanced fields", () => {
  const onAdvancedChange = vi.fn();
  const editorProps = {
    schema: objectSchema({
      memory: objectSchema({
        enabled: { type: "boolean", title: "Common memory field" },
        extraPaths: { type: "string", title: "Advanced memory field" },
      }),
    }),
    uiHints: {
      "memory.enabled": { advanced: false },
      "memory.extraPaths": { advanced: true },
    },
    value: { memory: { enabled: true, extraPaths: "/notes" } },
    activeSection: "memory",
    embedded: true,
    onShowAdvanced: () => onAdvancedChange(true),
    onHideAdvanced: () => onAdvancedChange(false),
    onPatch: vi.fn(),
  };
  const editor = (showAdvanced: boolean) => (
    <ConfigForm {...editorProps} showAdvanced={showAdvanced} />
  );

  for (const expanded of [false, true]) {
    const container = renderInto({ editor: editor(expanded) });
    const disclosure = container.querySelector<HTMLDetailsElement>(
      "details.config-advanced-disclosure",
    );
    expect(disclosure?.open).toBe(expanded);
    expect(container.textContent?.includes("Advanced memory field")).toBe(expanded);
    disclosure!.open = !expanded;
    disclosure!.dispatchEvent(new Event("toggle"));
    expect(onAdvancedChange).toHaveBeenCalledWith(!expanded);
  }

  const overview = renderInto({ activeTab: "overview", editor: editor(false) });
  expect(overview.querySelector("details.config-advanced-disclosure")).toBeNull();
});

const retainedFields = { citations: {}, search: {} };
const schema = objectSchema({
  memory: objectSchema({ ...retainedFields, internal: {} }),
  tools: {},
});

it("memorySettingsSchema keeps curated fields and drops siblings", () => {
  const narrowed = memorySettingsSchema(schema);
  expect(narrowed).toEqual(objectSchema({ memory: objectSchema(retainedFields) }));
  expect(memorySettingsSchema(schema)).toBe(narrowed);
});

it("memorySettingsSchema passes non-memory schemas through untouched", () => {
  const unrelated = { type: "object", properties: { tools: {} } };
  expect(memorySettingsSchema(unrelated)).toBe(unrelated);
  expect(memorySettingsSchema(null)).toBeNull();
});
