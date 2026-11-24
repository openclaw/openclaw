import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("embedded cyber failover target retirement", () => {
  it.each(["openai/retired-target", "", null, 42, {}, undefined])(
    "removes only the retired target %j while preserving routing and explicit disablement",
    (model) => {
      const defaults = {
        model: { primary: "openai/primary", fallbacks: ["openai/fallback@work"] },
        modelPolicy: { allow: ["openai/primary", "openai/fallback@work"] },
        embeddedAgent: {
          executionContract: "strict-agentic" as const,
          cyberFailover: { mode: "off" as const, cooloffMs: 1234 },
        },
      };
      const expected = {
        agents: {
          ownership: "explicit" as const,
          defaults,
          entries: { main: { model: "openai/agent@work" } },
        },
        auth: {
          profiles: { work: { provider: "openai", mode: "api_key" as const } },
          order: { openai: ["work"] },
        },
      };
      const raw = structuredClone(expected);
      Object.assign(raw.agents.defaults.embeddedAgent.cyberFailover, { model });
      const before = structuredClone(raw);

      expect(AgentDefaultsBaseSchema.safeParse(raw.agents.defaults).success).toBe(false);
      expect(findLegacyConfigIssues(raw)).toEqual([
        {
          path: "agents.defaults.embeddedAgent.cyberFailover",
          message: expect.stringContaining('Run "openclaw doctor --fix"'),
        },
      ]);

      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

      expect(migrated.partiallyValid).toBeUndefined();
      expect(migrated.sourceConfig).toEqual(expected);
      expect(migrated.config?.agents?.defaults).toEqual(defaults);
      expect(migrated.changes).toEqual([
        "Removed retired agents.defaults.embeddedAgent.cyberFailover.model; automatic cyber-policy retries use the active model through approved Daybreak access. Existing mode and cooloffMs settings were not changed.",
      ]);
      expect(raw).toEqual(before);
      expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
      expect(AgentDefaultsBaseSchema.safeParse(defaults).success).toBe(true);
      expect(
        migrateLegacyConfig(migrated.sourceConfig, {
          sourceConfigBeforeMigrations: migrated.sourceConfig,
        }).changes,
      ).toEqual([]);
    },
  );

  it.each([undefined, null, [], {}, { mode: "auto", cooloffMs: 500 }])(
    "leaves config without an own target untouched: %j",
    (cyberFailover) => {
      const raw = { agents: { defaults: { embeddedAgent: { cyberFailover } } } };
      const before = structuredClone(raw);

      expect(findLegacyConfigIssues(raw)).toEqual([]);
      expect(migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw })).toEqual({
        config: null,
        changes: [],
      });
      expect(raw).toEqual(before);
    },
  );
});
