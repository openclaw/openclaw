import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { applyMigrationItemSelection } from "./item-selection.js";
import {
  applyMigrationSelectedItemIds,
  applyMigrationSelections,
  formatMigrationSelectionHint,
  getDefaultMigrationSelectionValues,
  getSelectableMigrationItems,
  MIGRATION_SELECTION_TOGGLE_ALL_OFF as ALL_OFF,
  MIGRATION_SELECTION_TOGGLE_ALL_ON as ALL_ON,
  reconcileInteractiveMigrationEnterValues as enterValues,
  reconcileInteractiveMigrationShortcutValues as shortcutValues,
  reconcileInteractiveMigrationSkillToggleValues as toggleValues,
  resolveInteractiveMigrationSelection,
} from "./selection.js";

const MIGRATION_NOT_SELECTED_REASON = "not selected for migration";

function skillItem(name: string, overrides: Partial<MigrationItem> = {}): MigrationItem {
  return {
    id: `skill:${name}`,
    kind: "skill",
    action: "copy",
    status: "planned",
    source: `/tmp/codex/skills/${name}`,
    target: `/tmp/openclaw/workspace/skills/${name}`,
    details: { skillName: name, sourceLabel: "Codex skill" },
    ...overrides,
  };
}

function pluginItem(name: string, overrides: Partial<MigrationItem> = {}): MigrationItem {
  return {
    id: `plugin:${name}`,
    kind: "plugin",
    action: "install",
    status: "planned",
    source: `openai-curated/${name}`,
    target: `plugins.entries.codex.config.codexPlugins.plugins.${name}`,
    details: {
      configKey: name,
      marketplaceName: "openai-curated",
      pluginName: name,
    },
    ...overrides,
  };
}

function codexPluginConfigItem(pluginNames: string[]): MigrationItem {
  return {
    id: "config:codex-plugins",
    kind: "config",
    action: "merge",
    status: "planned",
    details: {
      value: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: Object.fromEntries(
              pluginNames.map((name) => [
                name,
                {
                  enabled: true,
                  marketplaceName: "openai-curated",
                  pluginName: name,
                },
              ]),
            ),
          },
        },
      },
    },
  };
}

function plan(items: MigrationItem[]): MigrationPlan {
  const countStatus = (status: MigrationItem["status"]) =>
    items.filter((item) => item.status === status).length;

  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: items.length,
      planned: countStatus("planned"),
      migrated: 0,
      skipped: countStatus("skipped"),
      conflicts: countStatus("conflict"),
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

function requireItem(items: MigrationItem[], id: string): MigrationItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`missing migration item ${id}`);
  }
  return item;
}

function expectItemStatus(
  items: MigrationItem[],
  id: string,
  status: MigrationItem["status"],
  reason?: string,
) {
  const item = requireItem(items, id);
  expect(item.status).toBe(status);
  if (reason !== undefined) {
    expect(item.reason).toBe(reason);
  }
}

describe("applyMigrationItemSelection", () => {
  it("keeps exact selected ids and skips other planned or conflicting items", () => {
    const selected = applyMigrationItemSelection(
      plan([
        skillItem("one", { id: "memory:one" }),
        skillItem("two", { id: "memory:two" }),
        skillItem("existing", {
          id: "memory:existing",
          status: "conflict",
          reason: "target exists",
        }),
      ]),
      ["memory:two"],
    );

    expectItemStatus(selected.items, "memory:one", "skipped", MIGRATION_NOT_SELECTED_REASON);
    expectItemStatus(selected.items, "memory:two", "planned");
    expectItemStatus(selected.items, "memory:existing", "skipped", MIGRATION_NOT_SELECTED_REASON);
    expect(selected.summary).toMatchObject({ planned: 1, skipped: 2, conflicts: 0 });
  });

  it("rejects stale or unavailable item ids", () => {
    expect(() =>
      applyMigrationItemSelection(plan([skillItem("one", { id: "memory:one" })]), ["memory:stale"]),
    ).toThrow('Unknown or unavailable migration item ids: "memory:stale".');
  });
});

describe("applyMigrationSelections skills", () => {
  it("can skip conflicting skills before apply conflict checks run", () => {
    const selected = applyMigrationSelections(
      plan([
        skillItem("alpha"),
        skillItem("beta", { status: "conflict", reason: "target exists" }),
      ]),
      { skills: ["alpha"] },
    );

    expect(selected.summary.conflicts).toBe(0);
    expectItemStatus(selected.items, "skill:alpha", "planned");
    expectItemStatus(selected.items, "skill:beta", "skipped", MIGRATION_NOT_SELECTED_REASON);
  });

  it("allows interactive selection to choose no skills", () => {
    const selected = applyMigrationSelectedItemIds(
      plan([
        skillItem("alpha"),
        skillItem("beta"),
        {
          id: "config:skill:alpha",
          kind: "config",
          action: "merge",
          status: "planned",
          details: { path: ["skills", "entries", "alpha"], value: { enabled: false } },
        },
      ]),
      new Set(),
      "skill",
    );

    expect(selected.summary).toMatchObject({ planned: 0, skipped: 3 });
    expect(selected.items.map((item) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("defaults interactive selection to planned skills only", () => {
    expect(
      getDefaultMigrationSelectionValues([
        skillItem("alpha"),
        skillItem("beta", { status: "conflict", reason: "target exists" }),
      ]),
    ).toEqual(["skill:alpha"]);
  });

  it("resolves interactive special options with toggle-off precedence over toggle-on", () => {
    const items = [
      skillItem("alpha"),
      skillItem("beta", { status: "conflict", reason: "target exists" }),
    ];

    expect(resolveInteractiveMigrationSelection(items, [ALL_ON, ALL_OFF])).toEqual(new Set());
    expect(resolveInteractiveMigrationSelection(items, [ALL_ON])).toEqual(
      new Set(["skill:alpha", "skill:beta"]),
    );
  });

  it("reconciles live interactive bulk toggle checkbox state", () => {
    const selectable = ["skill:alpha", "skill:beta"];

    expect(toggleValues([ALL_ON], ALL_ON, selectable)).toEqual([ALL_ON, ...selectable]);
    expect(toggleValues([ALL_ON, ...selectable, ALL_OFF], ALL_OFF, selectable)).toEqual([ALL_OFF]);
    expect(toggleValues([ALL_OFF, "skill:alpha"], "skill:alpha", selectable)).toEqual([
      "skill:alpha",
    ]);
    expect(shortcutValues(selectable, [ALL_ON, ALL_OFF, ...selectable], selectable, "a")).toEqual([
      ALL_OFF,
    ]);
    expect(shortcutValues([ALL_OFF], [ALL_OFF, ALL_ON], selectable, "i")).toEqual([ALL_OFF]);
  });

  it("reconciles enter as activating the cursor row without toggling it off", () => {
    const selectable = ["skill:alpha", "skill:beta"];

    expect(enterValues(["skill:alpha"], ALL_ON, selectable)).toEqual([ALL_ON, ...selectable]);
    expect(enterValues(["skill:alpha"], ALL_OFF, selectable)).toEqual([ALL_OFF]);
    expect(enterValues(["skill:alpha"], "skill:beta", selectable)).toEqual([
      "skill:alpha",
      "skill:beta",
    ]);
    expect(enterValues(["skill:alpha"], "skill:alpha", selectable)).toEqual(["skill:alpha"]);
    expect(
      enterValues(["skill:beta"], "skill:alpha", selectable, {
        preserveDeselectedActivatedValue: true,
      }),
    ).toEqual(["skill:beta"]);

    expect(enterValues(["skill:alpha"], undefined, selectable)).toEqual(["skill:alpha"]);
  });

  it("rejects unknown explicit skill selectors with available choices", () => {
    expect(() =>
      applyMigrationSelections(plan([skillItem("alpha"), skillItem("beta")]), {
        skills: ["gamma"],
      }),
    ).toThrow('No migratable skill matched "gamma". Available skills: alpha, beta.');
  });
});

describe("applyMigrationSelections plugins", () => {
  it.each([
    { value: undefined },
    { value: {} },
    { value: { config: { codexPlugins: { plugins: [] } } } },
  ])("leaves unrelated config shapes unchanged: %j", ({ value }) => {
    const item: MigrationItem = {
      id: "config:other",
      kind: "config",
      action: "merge",
      status: "planned",
      details: { value },
    };

    const selected = applyMigrationSelectedItemIds(plan([item]), new Set(), "plugin");

    expect(selected.items[0]).toBe(item);
  });

  it("keeps selected plugins and skips unselected plugin install items and config", () => {
    const initial = plan([
      pluginItem("google-calendar"),
      pluginItem("gmail"),
      codexPluginConfigItem(["google-calendar", "gmail"]),
    ]);
    const selected = applyMigrationSelections(
      applyMigrationItemSelection(initial, ["plugin:google-calendar", "plugin:gmail"]),
      { plugins: ["google-calendar"] },
    );

    expect(selected.summary).toMatchObject({ planned: 1, skipped: 2, conflicts: 0 });
    expectItemStatus(selected.items, "plugin:google-calendar", "planned");
    expectItemStatus(selected.items, "plugin:gmail", "skipped", MIGRATION_NOT_SELECTED_REASON);
    const configItem = requireItem(selected.items, "config:codex-plugins");
    expectItemStatus(
      selected.items,
      "config:codex-plugins",
      "skipped",
      MIGRATION_NOT_SELECTED_REASON,
    );
    expect(configItem.details).toEqual({
      value: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
      },
    });
  });

  it("skips the Codex plugin config item when no plugin remains selected", () => {
    const selected = applyMigrationSelections(
      plan([
        pluginItem("google-calendar"),
        pluginItem("gmail"),
        codexPluginConfigItem(["google-calendar", "gmail"]),
      ]),
      { plugins: [] },
    );

    expect(selected.summary).toMatchObject({ planned: 0, skipped: 3, conflicts: 0 });
    expectItemStatus(
      selected.items,
      "plugin:google-calendar",
      "skipped",
      MIGRATION_NOT_SELECTED_REASON,
    );
    expectItemStatus(selected.items, "plugin:gmail", "skipped", MIGRATION_NOT_SELECTED_REASON);
    expectItemStatus(
      selected.items,
      "config:codex-plugins",
      "skipped",
      MIGRATION_NOT_SELECTED_REASON,
    );
  });

  it("includes conflicting plugins in the selector with a conflict hint", () => {
    const items = [
      pluginItem("google-calendar"),
      pluginItem("gmail", { status: "conflict", reason: "plugin exists" }),
    ];

    expect(getSelectableMigrationItems(plan(items), "plugin").map((item) => item.id)).toEqual([
      "plugin:google-calendar",
      "plugin:gmail",
    ]);
    expect(
      formatMigrationSelectionHint(expectDefined(items[1], "items[1] test invariant"), "plugin"),
    ).toBe("openai-curated plugin already installed in workspace");
  });

  it("rejects unknown explicit plugin selectors with available choices", () => {
    expect(() =>
      applyMigrationSelections(plan([pluginItem("google-calendar"), pluginItem("gmail")]), {
        plugins: ["calendar"],
      }),
    ).toThrow(
      'No migratable plugin matched "calendar". Available plugins: gmail, google-calendar.',
    );
  });
});
