/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderConfigForm } from "../../components/config-form.ts";
import { memorySettingsSchema } from "./memory-schema.ts";
import { renderMemory } from "./memory.ts";

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
    overview: html`<div class="test-overview"></div>`,
    memories: html`<div class="test-memories"></div>`,
    dreams: html`<div class="test-dreams"></div>`,
    editor: html`<div class="test-editor"></div>`,
    dreamingSettings: html`<div class="test-dreaming-settings"></div>`,
    ...overrides,
  };
}

function renderInto(props: MemoryViewProps): HTMLElement {
  const container = document.createElement("div");
  render(renderMemory(props), container);
  return container;
}

describe("renderMemory", () => {
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
    const editor = (showAdvanced: boolean) =>
      html`${renderConfigForm({
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
      })}`;

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
