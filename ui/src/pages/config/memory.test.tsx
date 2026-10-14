/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ConfigForm } from "../../components/config-form.render.tsx";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { memorySettingsSchema } from "./memory-schema.ts";
import { buildMemoryAddonRows, Memory, type MemoryCatalogState } from "./memory.tsx";

/** The view is the only public surface, so its props type comes from its signature. */
type MemoryViewProps = Parameters<typeof Memory>[0];

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
    addons: [
      {
        id: "active-memory",
        label: "Active memory",
        description: "Recent context",
        state: "enabled",
        busy: false,
        error: null,
        notice: null,
      },
      {
        id: "memory-wiki",
        label: "Memory wiki",
        description: "Wiki pages",
        state: "disabled",
        busy: false,
        error: null,
        notice: null,
      },
    ],
    canToggleAddons: true,
    onAddonChange: vi.fn(),
    pluginsHref: "/settings/plugins",
    memoryImportHref: "/memory-import",
    canImportMemory: true,
    overview: <div class="test-overview" />,
    memories: <div class="test-memories" />,
    dreams: <div class="test-dreams" />,
    editor: <div class="test-editor" />,
    dreamingSettings: <div class="test-dreaming-settings" />,
    ...overrides,
  };
}

function renderInto(props: MemoryViewProps): HTMLElement {
  const { container } = mountSolid(() => <Memory {...props} />);
  flush();
  return container;
}

describe("memory add-on rows", () => {
  it("translates declared labels on each read without changing row order", async () => {
    const rows = () =>
      buildMemoryAddonRows(
        { kind: "loading" },
        {
          busy: new Set(),
          errors: new Map(),
          notices: new Map(),
          refreshWarnings: new Map(),
        },
      ).map(({ id, label }) => ({ id, label }));
    const english = [
      { id: "active-memory", label: "Active memory" },
      { id: "memory-wiki", label: "Memory wiki" },
    ];
    try {
      await i18n.setLocale("en");
      expect(rows()).toEqual(english);
      await i18n.setLocale("fr");
      expect(rows()).toEqual([
        { id: "active-memory", label: "Mémoire active" },
        { id: "memory-wiki", label: "Wiki de mémoire" },
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
      const rows = buildMemoryAddonRows(catalog, {
        busy: new Set(),
        errors: new Map(),
        notices: new Map(),
        refreshWarnings: new Map(),
      });
      expect(
        rows.map(({ id, label, description, state }) => ({ id, label, description, state })),
      ).toEqual([
        {
          id: "active-memory",
          label: "Active memory",
          description: "active-memory",
          state: expectedState,
        },
        {
          id: "memory-wiki",
          label: "Memory wiki",
          description: "memory-wiki",
          state: expectedState,
        },
      ]);
    },
  );
});

describe("Memory", () => {
  it("retains engine and add-on controls when their owner publishes new state", () => {
    const [props, setProps] = createSignal(createProps());
    const { container } = mountSolid(() => <Memory {...props()} />);
    flush();
    const engine = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="memory-core"]',
    );
    const addon = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(engine).not.toBeNull();
    expect(addon).not.toBeNull();
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
    const container = renderInto(createProps({ canImportMemory: false }));

    expect(container.querySelector('a[href="/memory-import"]')).toBeNull();
    expect(container.textContent).toContain("Memory import requires operator.admin access.");
  });

  it("keeps a configured missing engine selected and labels it unavailable", () => {
    const container = renderInto(
      createProps({
        engineOptions: [{ id: "retired-memory", label: "retired-memory", available: false }],
        engineSelection: { kind: "pinned", pluginId: "retired-memory" },
        engineState: "unknown",
      }),
    );

    expect(
      container
        .querySelector('.settings-segmented__btn:has(input[value="retired-memory"])')
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("retired-memory (Unavailable)");
    expect(
      container.querySelector<HTMLInputElement>(
        '.settings-segmented__input[value="retired-memory"]',
      )?.checked,
    ).toBe(true);
  });

  it("shows the shared advanced disclosure only on Settings and reveals advanced fields", () => {
    const onAdvancedChange = vi.fn();
    const editor = (showAdvanced: boolean) => (
      <ConfigForm
        {...{
          schema: {
            type: "object",
            properties: {
              memory: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", title: "Common memory field" },
                  extraPaths: { type: "string", title: "Advanced memory field" },
                },
              },
            },
          },
          uiHints: {
            "memory.enabled": { advanced: false },
            "memory.extraPaths": { advanced: true },
          },
          value: { memory: { enabled: true, extraPaths: "/notes" } },
          activeSection: "memory",
          embedded: true,
          showAdvanced,
          onShowAdvanced: () => onAdvancedChange(true),
          onHideAdvanced: () => onAdvancedChange(false),
          onPatch: vi.fn(),
        }}
      />
    );

    const collapsed = renderInto(createProps({ editor: editor(false) }));
    const show = collapsed.querySelector<HTMLDetailsElement>("details.config-advanced-disclosure");
    expect(show?.open).toBe(false);
    expect(collapsed.textContent).not.toContain("Advanced memory field");
    show!.open = true;
    show!.dispatchEvent(new Event("toggle"));
    expect(onAdvancedChange).toHaveBeenCalledWith(true);

    const expanded = renderInto(createProps({ editor: editor(true) }));
    const hide = expanded.querySelector<HTMLDetailsElement>("details.config-advanced-disclosure");
    expect(hide?.open).toBe(true);
    expect(expanded.textContent).toContain("Advanced memory field");
    hide!.open = false;
    hide!.dispatchEvent(new Event("toggle"));
    expect(onAdvancedChange).toHaveBeenCalledWith(false);

    const overview = renderInto(createProps({ activeTab: "overview", editor: editor(false) }));
    expect(overview.querySelector("details.config-advanced-disclosure")).toBeNull();
  });
});

describe("memorySettingsSchema", () => {
  const schema = {
    type: "object",
    properties: {
      memory: {
        type: "object",
        properties: {
          citations: { type: "string" },
          search: { type: "object" },
          internal: { type: "object" },
        },
      },
      tools: { type: "object" },
    },
  };

  it("keeps the curated settings and drops other fields and sibling sections", () => {
    const narrowed = memorySettingsSchema(schema) as {
      properties: { memory: { properties: Record<string, unknown> }; tools?: unknown };
    };

    expect(Object.keys(narrowed.properties)).toEqual(["memory"]);
    expect(Object.keys(narrowed.properties.memory.properties)).toEqual(["citations", "search"]);
    expect(memorySettingsSchema(schema)).toBe(narrowed);
  });

  it("passes non-memory schemas through untouched", () => {
    const unrelated = { type: "object", properties: { tools: {} } };
    expect(memorySettingsSchema(unrelated)).toBe(unrelated);
    expect(memorySettingsSchema(null)).toBeNull();
  });
});
