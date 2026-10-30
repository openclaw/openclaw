/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { i18n, t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { memorySettingsSchema } from "./memory-schema.ts";
import { Memory, type MemoryCatalogState } from "./memory.tsx";

type MemoryViewProps = Parameters<typeof Memory>[0];
const addonLabels = [
  ["active-memory", "Active memory"],
  ["memory-wiki", "Memory wiki"],
] as const;

function createProps(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    activeTab: "settings",
    onTabChange: vi.fn(),
    catalog: { kind: "loading" },
    addonOutcomes: { errors: {}, notices: {}, refreshWarnings: {} },
    readAddonExpected: () => undefined,
    readAddonBusy: () => false,
    engineSelection: { kind: "default", pluginId: "memory-core" },
    engineDisabled: false,
    engineSaving: false,
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

it("names the page with a level-one heading", () => {
  const container = renderInto();
  expect(getQueriesForElement(container).getByRole("heading", { level: 1 }).textContent).toBe(
    "Memory",
  );
});

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

it("renders the shared editor only on Settings", () => {
  const editor = <div data-memory-editor>Advanced memory field</div>;
  const settings = renderInto({ editor });
  expect(settings.querySelector("[data-memory-editor]")?.textContent).toBe("Advanced memory field");
  const overview = renderInto({ activeTab: "overview", editor });
  expect(overview.querySelector("[data-memory-editor]")).toBeNull();
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
