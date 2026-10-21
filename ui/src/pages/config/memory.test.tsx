/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { ConfigForm } from "../../components/config-form.render.tsx";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { i18n, t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { memorySettingsSchema } from "./memory-schema.ts";
import { Memory, type MemoryCatalogState } from "./memory.tsx";

type MemoryViewProps = Parameters<typeof Memory>[0];
const addonLabels = [
  ["active-memory", "Active memory", "Recent context", "enabled"],
  ["memory-wiki", "Memory wiki", "Wiki pages", "disabled"],
] as const;
const emptyOutcomes = () => ({
  busy: {},
  errors: {},
  notices: {},
  refreshWarnings: {},
});

function createProps(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    activeTab: "settings",
    onTabChange: vi.fn(),
    catalog: {
      kind: "ready",
      mutationAllowed: true,
      plugins: [
        {
          id: "memory-core",
          name: "OpenClaw Memory",
          kind: ["memory"],
          installed: true,
          enabled: true,
          state: "enabled",
        },
        {
          id: "memory-lancedb",
          name: "Memory LanceDB",
          kind: ["memory"],
          installed: true,
          enabled: true,
          state: "enabled",
        },
        ...addonLabels.map(([id, name, description, state]) => ({
          id,
          name,
          description,
          state,
          installed: true,
          enabled: state === "enabled",
        })),
      ],
    },
    addonOutcomes: emptyOutcomes(),
    engineSelection: { kind: "default", pluginId: "memory-core" },
    engineBusy: false,
    engineOutcome: null,
    onEngineChange: vi.fn(),
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

function addonRows(container: HTMLElement) {
  const section = [...container.querySelectorAll(".settings-section")].find(
    (item) => item.querySelector("h2")?.textContent === t("memoryPage.addons.title"),
  );
  return [...(section?.querySelectorAll(".settings-row") ?? [])].slice(0, 2);
}

it("translates declared labels without changing row order", async () => {
  try {
    await i18n.setLocale("en");
    const container = renderInto({ catalog: { kind: "loading" } });
    const labels = () =>
      addonRows(container).map((row) => row.querySelector(".settings-row__title")?.textContent);
    expect(labels()).toEqual(["Active memory", "Memory wiki"]);
    await i18n.setLocale("fr");
    flush();
    expect(labels()).toEqual(["Mémoire active", "Wiki de mémoire"]);
    await i18n.setLocale("en");
    flush();
    expect(labels()).toEqual(["Active memory", "Memory wiki"]);
  } finally {
    await i18n.setLocale("en");
  }
});

it.each([
  [{ kind: "loading" }, "Loading…"],
  [{ kind: "unavailable" }, "Unknown"],
  [{ kind: "ready", plugins: [], mutationAllowed: false }, "Unknown"],
] satisfies [MemoryCatalogState, string][])(
  "keeps bundled add-ons visible and ordered with a %j catalog",
  (catalog, expectedState) => {
    const container = renderInto({ catalog });
    const rows = addonRows(container).map((row) => [
      row.querySelector(".settings-row__title")?.textContent,
      row.querySelector(".settings-row__desc")?.textContent,
      row.querySelector(".settings-status")?.textContent?.trim(),
    ]);
    expect(rows).toEqual(addonLabels.map(([id, label]) => [label, id, expectedState]));
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
    catalog:
      current.catalog.kind === "ready"
        ? {
            ...current.catalog,
            plugins: current.catalog.plugins.map((item) => ({
              ...item,
              enabled: false,
              state: "disabled",
            })),
          }
        : current.catalog,
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
    catalog: { kind: "ready", plugins: [], mutationAllowed: true },
    engineSelection: { kind: "pinned", pluginId: "retired-memory" },
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
