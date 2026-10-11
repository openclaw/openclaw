/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ConfigForm } from "../../components/config-form.render.tsx";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { memoryTabForRoute, memorySettingsSchema } from "./memory-schema.ts";
import { Memory, renderMemory } from "./memory.tsx";

/** The view is the only public surface, so its props type comes from its signature. */
type MemoryViewProps = Parameters<typeof renderMemory>[0];

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
  const { container } = mountSolid(() => renderMemory(props));
  flush();
  return container;
}

describe("renderMemory", () => {
  it.each(["overview", "memories", "dreams"] as const)(
    "renders the Memory tabs without a duplicate agent picker on %s",
    (activeTab) => {
      const container = renderInto(createProps({ activeTab }));
      const header = container.querySelector(".hub-page-header");

      expect(header?.querySelector(".page-title")?.textContent).toBe("Memory");
      expect(header?.querySelector(".page-subtitle")?.textContent).toContain(
        "Choose how OpenClaw stores, searches, and maintains agent memory.",
      );
      expect(header?.querySelector(".memory-hub-tabs")).not.toBeNull();
      expect(container.textContent).not.toContain("Agent view");

      expect(header?.querySelector("openclaw-agent-select")).toBeNull();
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

  it("reports whether the engine came from config or from the slot default", () => {
    const auto = renderInto(createProps());
    expect(auto.textContent).toContain("falls back to its default owner");
    expect(auto.textContent).not.toContain("Using default:");

    const pinned = renderInto(
      createProps({ engineSelection: { kind: "pinned", pluginId: "memory-core" } }),
    );
    expect(pinned.textContent).toContain("pinned in config");
    expect(pinned.textContent).toContain("Default: OpenClaw Memory");
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

  it("renders enabled and disabled add-ons as accessible toggles", () => {
    const { container, getByRole } = mountSolid(() => renderMemory(createProps()));
    flush();

    const switches = [...container.querySelectorAll<HTMLInputElement>(".settings-toggle__input")];
    expect(switches).toHaveLength(2);
    expect(switches[0]?.checked).toBe(true);
    expect(switches[1]?.checked).toBe(false);
    expect(getByRole("switch", { name: "Enable or disable Active memory" })).toBe(switches[0]);
    expect(getByRole("switch", { name: "Enable or disable Memory wiki" })).toBe(switches[1]);
    const link = container.querySelector<HTMLAnchorElement>("a.memory-page__link");
    expect(link?.getAttribute("href")).toBe("/settings/plugins");
  });

  it("keeps config only on Settings and the agent experience on Dreams", () => {
    expect(
      renderInto(createProps({ activeTab: "overview" })).querySelector(".test-overview"),
    ).not.toBeNull();
    expect(
      renderInto(createProps({ activeTab: "memories" })).querySelector(".test-memories"),
    ).not.toBeNull();

    const settings = renderInto(createProps({ activeTab: "settings" }));
    expect(settings.querySelector(".test-editor")).not.toBeNull();
    expect(settings.querySelector(".test-dreaming-settings")).not.toBeNull();

    const dreams = renderInto(createProps({ activeTab: "dreams" }));
    expect(dreams.querySelector(".test-dreams")).not.toBeNull();
    expect(dreams.querySelector(".test-editor")).toBeNull();
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

describe("memoryTabForRoute", () => {
  it("keeps old shared links working with the new destinations", () => {
    expect(memoryTabForRoute({ tab: "search" })).toBe("settings");
    expect(memoryTabForRoute({ tab: "dreaming" })).toBe("dreams");
    expect(memoryTabForRoute({ tab: "overview" })).toBe("overview");
    expect(memoryTabForRoute({ tab: "memories" })).toBe("memories");
    expect(memoryTabForRoute({ tab: "unknown" })).toBeNull();
  });

  it("prefers an explicit canonical path over stale legacy route state", () => {
    expect(
      memoryTabForRoute({
        pathname: "/settings/memory/dreams",
        tab: "settings",
        section: "memory",
        targetBlockId: "config-section-memory",
      }),
    ).toBe("dreams");
    expect(memoryTabForRoute({ pathname: "/settings/memory" })).toBe("overview");
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
  });

  it("returns a stable object so schema analysis stays cached", () => {
    expect(memorySettingsSchema(schema)).toBe(memorySettingsSchema(schema));
  });

  it("passes non-memory schemas through untouched", () => {
    const unrelated = { type: "object", properties: { tools: {} } };
    expect(memorySettingsSchema(unrelated)).toBe(unrelated);
    expect(memorySettingsSchema(null)).toBeNull();
  });
});
