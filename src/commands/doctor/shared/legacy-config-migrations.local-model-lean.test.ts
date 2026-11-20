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
    { model: { primary: "openai/selected" }, localModelLean: true, expected: "openclaw/lean" },
    { model: "ollama/local", localModelLean: false, expected: undefined },
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
    expect(raw.agents.entries).toEqual({ work: { agentProfileId: "openclaw/lean" } });
    if (expected === "openclaw/lean") {
      expect(changes).toContainEqual(expect.stringContaining("remove it to restore"));
    }
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    const migrated = structuredClone(raw);
    expect(applyRetiredMigrations(raw)).toEqual({ raw: migrated, changes: [] });
  });
});

describe("local-model lean to Agent Profile migration", () => {
  it.each([
    // [defaults flag, agent flag, expected defaults profile, expected agent profile]
    // false is the default and is dropped, unless it opts an agent out of a lean default.
    [true, undefined, "openclaw/lean", undefined],
    [false, undefined, undefined, undefined],
    [undefined, true, undefined, "openclaw/lean"],
    [undefined, false, undefined, undefined],
    [true, false, "openclaw/lean", "openclaw/base"],
    [false, true, undefined, "openclaw/lean"],
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

  it("drops a leftover agent experimental block and keeps other default flags", () => {
    const raw: Record<string, unknown> = {
      agents: {
        defaults: { experimental: { decisionAssistance: true } },
        entries: { work: { experimental: {} } },
      },
    };
    expect(findLegacyConfigIssues(raw)).not.toEqual([]);
    applyRetiredMigrations(raw);
    expect(raw).toEqual({
      agents: { defaults: { experimental: { decisionAssistance: true } }, entries: { work: {} } },
    });
    expect(validateConfigObject(raw).ok).toBe(true);
  });

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
