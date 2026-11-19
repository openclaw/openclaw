import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObject } from "../../../config/validation.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetiredMigrations(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("automatic local-model lean migration", () => {
  it.each([
    { model: "ollama/local", localModelLean: true, expected: undefined },
    { model: { primary: "openai/selected" }, localModelLean: true, expected: "openclaw/small" },
    { model: "ollama/local", localModelLean: false, expected: "openclaw/base" },
  ])("retires only proven automatic lean ownership: %j", ({ model, localModelLean, expected }) => {
    const raw = {
      wizard: { localModelLeanAutoModel: "ollama/local", lastRunVersion: "2026.9.1" },
      agents: {
        defaults: {
          model,
          experimental: { localModelLean, other: "preserved" },
        } as Record<string, unknown>,
        entries: { work: { experimental: { localModelLean: true } } },
      },
    };
    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "wizard.localModelLeanAutoModel",
      message: expect.stringContaining('Run "openclaw doctor --fix"'),
    });

    const { changes } = applyRetiredMigrations(raw);

    expect(raw.wizard).toEqual({ lastRunVersion: "2026.9.1" });
    expect(raw.agents.defaults.experimental).toEqual({ other: "preserved" });
    expect(raw.agents.defaults.agentProfileId).toBe(expected);
    expect(raw.agents.entries).toEqual({ work: { agentProfileId: "openclaw/small" } });
    if (expected === "openclaw/small") {
      expect(changes).toContainEqual(expect.stringContaining('set it to "openclaw/base"'));
    }
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    const migrated = structuredClone(raw);
    expect(applyRetiredMigrations(raw)).toEqual({ raw: migrated, changes: [] });
  });
});

describe("local-model lean to Agent Profile migration", () => {
  it.each([
    // [defaults flag, agent flag, expected defaults profile, expected agent profile]
    [true, undefined, "openclaw/small", undefined],
    [false, undefined, "openclaw/base", undefined],
    [undefined, true, undefined, "openclaw/small"],
    [undefined, false, undefined, "openclaw/base"],
    [true, false, "openclaw/small", "openclaw/base"],
    [false, true, "openclaw/base", "openclaw/small"],
  ] as const)(
    "maps defaults=%s agent=%s at the same scope",
    (defaultsLean, agentLean, defaultsProfile, agentProfile) => {
      const raw: Record<string, unknown> = {
        agents: {
          defaults:
            defaultsLean === undefined ? {} : { experimental: { localModelLean: defaultsLean } },
          entries: {
            work: agentLean === undefined ? {} : { experimental: { localModelLean: agentLean } },
          },
        },
      };
      expect(findLegacyConfigIssues(raw)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("agentProfileId") }),
      );

      applyRetiredMigrations(raw);

      expect(raw).toEqual({
        agents: {
          defaults: defaultsProfile ? { agentProfileId: defaultsProfile } : {},
          entries: { work: agentProfile ? { agentProfileId: agentProfile } : {} },
        },
      });
      expect(findLegacyConfigIssues(raw)).toEqual([]);
      expect(validateConfigObject(raw).ok).toBe(true);
    },
  );

  it("keeps an explicit agentProfileId at the same scope and reports the conflict", () => {
    const raw: Record<string, unknown> = {
      agents: {
        defaults: {
          agentProfileId: "openclaw/base",
          experimental: { localModelLean: true, decisionAssistance: true },
        },
      },
    };
    const { changes } = applyRetiredMigrations(raw);
    expect(raw).toEqual({
      agents: {
        defaults: { agentProfileId: "openclaw/base", experimental: { decisionAssistance: true } },
      },
    });
    expect(changes).toContainEqual(
      expect.stringContaining("kept agents.defaults.agentProfileId=openclaw/base"),
    );
  });
});
