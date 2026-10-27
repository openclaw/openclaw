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

function selectionItem(
  kind: "skill" | "plugin",
  name: string,
  overrides: Partial<MigrationItem> = {},
): MigrationItem {
  return {
    id: `${kind}:${name}`,
    kind,
    action: kind === "skill" ? "copy" : "install",
    status: "planned",
    source: kind === "skill" ? `/tmp/codex/skills/${name}` : `openai-curated/${name}`,
    target: kind === "skill" ? `/tmp/openclaw/workspace/skills/${name}` : `plugins.${name}`,
    details:
      kind === "skill"
        ? { skillName: name, sourceLabel: "Codex skill" }
        : { configKey: name, marketplaceName: "openai-curated", pluginName: name },
    ...overrides,
  };
}

const skillItem = selectionItem.bind(null, "skill");
const pluginItem = selectionItem.bind(null, "plugin");

function codexPluginConfigItem(pluginNames: string[]): MigrationItem {
  const codexPlugins = {
    enabled: true,
    allow_destructive_actions: true,
    plugins: Object.fromEntries(
      pluginNames.map((name) => [
        name,
        { enabled: true, marketplaceName: "openai-curated", pluginName: name },
      ]),
    ),
  };
  return {
    id: "config:codex-plugins",
    kind: "config",
    action: "merge",
    status: "planned",
    details: { value: { enabled: true, config: { codexPlugins } } },
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

function expectItemStatus(
  items: MigrationItem[],
  id: string,
  status: MigrationItem["status"],
  reason?: string,
) {
  expect(items).toContainEqual(
    expect.objectContaining({ id, status, ...(reason === undefined ? {} : { reason }) }),
  );
}

function pluginPlan(gmailStatus: MigrationItem["status"] = "planned"): MigrationPlan {
  return plan([
    pluginItem("google-calendar"),
    pluginItem("gmail", { status: gmailStatus }),
    codexPluginConfigItem(["google-calendar", "gmail"]),
  ]);
}

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
    const alpha = "skill:alpha";
    const selectable = [alpha, "skill:beta"];

    expect(toggleValues([ALL_ON], ALL_ON, selectable)).toEqual([ALL_ON, ...selectable]);
    expect(toggleValues([ALL_ON, ...selectable, ALL_OFF], ALL_OFF, selectable)).toEqual([ALL_OFF]);
    expect(toggleValues([ALL_OFF, alpha], alpha, selectable)).toEqual([alpha]);
    expect(shortcutValues(selectable, [ALL_ON, ALL_OFF, ...selectable], selectable, "a")).toEqual([
      ALL_OFF,
    ]);
    expect(shortcutValues([ALL_OFF], [ALL_OFF, ALL_ON], selectable, "i")).toEqual([ALL_OFF]);
  });

  it("reconciles enter as activating the cursor row without toggling it off", () => {
    const alpha = "skill:alpha";
    const beta = "skill:beta";
    const selectable = [alpha, beta];

    expect(enterValues([alpha], ALL_ON, selectable)).toEqual([ALL_ON, ...selectable]);
    expect(enterValues([alpha], ALL_OFF, selectable)).toEqual([ALL_OFF]);
    expect(enterValues([alpha], beta, selectable)).toEqual([alpha, beta]);
    expect(enterValues([alpha], alpha, selectable)).toEqual([alpha]);
    expect(
      enterValues([beta], alpha, selectable, {
        preserveDeselectedActivatedValue: true,
      }),
    ).toEqual([beta]);

    expect(enterValues([alpha], undefined, selectable)).toEqual([alpha]);
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
    const selected = applyMigrationSelections(
      applyMigrationItemSelection(pluginPlan("conflict"), [
        "plugin:google-calendar",
        "plugin:gmail",
      ]),
      { plugins: ["google-calendar"] },
    );

    expect(selected.summary).toMatchObject({ planned: 1, skipped: 2, conflicts: 0 });
    expectItemStatus(selected.items, "plugin:google-calendar", "planned");
    expectItemStatus(selected.items, "plugin:gmail", "skipped", MIGRATION_NOT_SELECTED_REASON);
    expect(selected.items).toContainEqual(
      expect.objectContaining({
        id: "config:codex-plugins",
        status: "skipped",
        reason: MIGRATION_NOT_SELECTED_REASON,
        details: codexPluginConfigItem(["google-calendar"]).details,
      }),
    );
  });

  it("skips the Codex plugin config item when no plugin remains selected", () => {
    const selected = applyMigrationSelections(pluginPlan(), { plugins: [] });

    expect(selected.summary).toMatchObject({ planned: 0, skipped: 3, conflicts: 0 });
    for (const id of ["plugin:google-calendar", "plugin:gmail", "config:codex-plugins"]) {
      expectItemStatus(selected.items, id, "skipped", MIGRATION_NOT_SELECTED_REASON);
    }
  });

  it("includes conflicting plugins in the selector with a conflict hint", () => {
    const conflict = pluginItem("gmail", { status: "conflict", reason: "plugin exists" });
    const items = [pluginItem("google-calendar"), conflict];

    expect(getSelectableMigrationItems(plan(items), "plugin").map((item) => item.id)).toEqual([
      "plugin:google-calendar",
      "plugin:gmail",
    ]);
    expect(formatMigrationSelectionHint(conflict, "plugin")).toBe(
      "openai-curated plugin already installed in workspace",
    );
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
