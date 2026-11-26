import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObject } from "../../../config/validation-core.js";
import { LEGACY_CONFIG_MIGRATIONS_AGENT_PROFILES } from "./legacy-config-migrations.agent-profiles.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  LEGACY_CONFIG_MIGRATIONS_AGENT_PROFILES[0]?.apply(raw, changes);
  return { changes, raw };
}

const flag = (localModelLean: boolean, extra: Record<string, unknown> = {}) => ({
  experimental: { localModelLean },
  ...extra,
});

describe("retired localModelLean to Agent Profile migration", () => {
  it("true at defaults becomes openclaw/small at defaults", () => {
    const result = migrate({ agents: { defaults: flag(true) } });
    expect(result.raw).toEqual({ agents: { defaults: { agentProfileId: "openclaw/small" } } });
    expect(result.changes).toHaveLength(1);
  });

  it("true on an entry and a list item becomes openclaw/small at the same scope", () => {
    const result = migrate({
      agents: {
        entries: { coding: flag(true) },
        list: [{ id: "legacy", ...flag(true) }],
      },
    });
    expect(result.raw).toEqual({
      agents: {
        entries: { coding: { agentProfileId: "openclaw/small" } },
        list: [{ id: "legacy", agentProfileId: "openclaw/small" }],
      },
    });
  });

  it("false at defaults becomes openclaw/base and keeps other experimental values", () => {
    const result = migrate({
      agents: { defaults: { experimental: { localModelLean: false, otherPreview: true } } },
    });
    expect(result.raw).toEqual({
      agents: {
        defaults: { agentProfileId: "openclaw/base", experimental: { otherPreview: true } },
      },
    });
    expect(result.changes).toHaveLength(1);
  });

  it.each([
    ["no default flag", {}, {}],
    [
      "a false default",
      { defaults: flag(false) },
      { defaults: { agentProfileId: "openclaw/base" } },
    ],
    [
      "a true default",
      { defaults: flag(true) },
      { defaults: { agentProfileId: "openclaw/small" } },
    ],
  ])("false on an entry and a list item with %s becomes openclaw/base", (_name, defaults, out) => {
    const result = migrate({
      agents: {
        ...defaults,
        entries: { full: flag(false), inherited: {} },
        list: [{ id: "x", ...flag(false) }],
      },
    });
    expect(result.raw).toEqual({
      agents: {
        ...out,
        entries: { full: { agentProfileId: "openclaw/base" }, inherited: {} },
        list: [{ id: "x", agentProfileId: "openclaw/base" }],
      },
    });
  });

  it("is idempotent and leaves an absent flag alone", () => {
    const raw = { agents: { defaults: flag(false), entries: { full: flag(false), plain: {} } } };
    migrate(raw);
    const again = migrate(raw);
    expect(again.changes).toEqual([]);
    expect(raw).toEqual({
      agents: {
        defaults: { agentProfileId: "openclaw/base" },
        entries: { full: { agentProfileId: "openclaw/base" }, plain: {} },
      },
    });
  });

  it("writes a config that passes validation", () => {
    const result = migrate({
      agents: {
        ownership: "explicit",
        defaults: flag(false),
        entries: { fast: flag(true), full: flag(false) },
      },
    });
    const validation = validateConfigObject(result.raw);
    expect(validation.ok ? [] : validation.issues).toEqual([]);
  });

  it("keeps an explicit profile when the legacy flag is false", () => {
    const result = migrate({
      agents: { entries: { a: flag(false, { agentProfileId: "openclaw/small" }) } },
    });
    expect(result.raw).toEqual({
      agents: { entries: { a: { agentProfileId: "openclaw/small" } } },
    });
  });

  it("true on an agent under a false default selects small only for that agent", () => {
    const result = migrate({
      agents: { defaults: flag(false), entries: { fast: flag(true) } },
    });
    expect(result.raw).toEqual({
      agents: {
        defaults: { agentProfileId: "openclaw/base" },
        entries: { fast: { agentProfileId: "openclaw/small" } },
      },
    });
  });

  it("true on an agent under a true default selects small on that agent", () => {
    const result = migrate({ agents: { defaults: flag(true), entries: { a: flag(true) } } });
    expect(result.raw).toEqual({
      agents: {
        defaults: { agentProfileId: "openclaw/small" },
        entries: { a: { agentProfileId: "openclaw/small" } },
      },
    });
  });

  it("keeps an explicit profile and drops the legacy flag", () => {
    const result = migrate({
      agents: { defaults: flag(true, { agentProfileId: "openclaw/base" }) },
    });
    expect(result.raw).toEqual({ agents: { defaults: { agentProfileId: "openclaw/base" } } });
    expect(result.changes[0]).toContain("kept the explicit Agent Profile");
  });

  it("reports the legacy key until doctor migrates it", () => {
    const raw = { agents: { entries: { a: flag(true) } } };
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("agents.entries");
    migrate(raw);
    expect(findLegacyConfigIssues(raw)).toEqual([]);
  });
});

describe("empty experimental block on an agent", () => {
  it("is reported and removed from entries and list items, but kept at defaults", () => {
    const raw = {
      agents: {
        defaults: { experimental: {} },
        entries: { work: { experimental: {} } },
        list: [{ id: "legacy", experimental: {} }],
      },
    };
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["agents.entries", "agents.list"]),
    );

    const result = migrate(raw);

    expect(result.raw).toEqual({
      agents: {
        defaults: { experimental: {} },
        entries: { work: {} },
        list: [{ id: "legacy" }],
      },
    });
  });
});

describe("migration order in the full doctor pipeline", () => {
  function migrateAll(raw: Record<string, unknown>) {
    const changes: string[] = [];
    for (const migration of LEGACY_CONFIG_MIGRATIONS) {
      migration.apply(raw, changes);
    }
    return raw;
  }

  it("retires onboarding-owned lean instead of pinning openclaw/small", () => {
    const raw = migrateAll({
      wizard: { localModelLeanAutoModel: "ollama/local" },
      agents: { defaults: { model: "ollama/local", ...flag(true) } },
    });
    const defaults = getAgentDefaults(raw);
    expect(defaults.agentProfileId).toBeUndefined();
    expect(defaults.experimental).toEqual({});
  });

  it("maps an operator-set lean flag to openclaw/small", () => {
    const raw = migrateAll({
      wizard: { lastRunVersion: "2026.9.1" },
      agents: { defaults: { model: "ollama/local", ...flag(true) } },
    });
    expect(getAgentDefaults(raw)).toEqual({
      model: "ollama/local",
      agentProfileId: "openclaw/small",
    });
  });
});

function getAgentDefaults(raw: Record<string, unknown>) {
  return (raw.agents as { defaults: Record<string, unknown> }).defaults;
}
