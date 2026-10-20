import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

function agentRoster<T>(roster: string, agent: T) {
  return roster === "entries" ? { entries: { main: agent } } : { list: [{ id: "main", ...agent }] };
}

function checkMigration(raw: unknown, key: string, message: string) {
  const original = structuredClone(raw);
  expect(findLegacyConfigIssues(raw)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: `tools.codeMode.${key}` }),
      expect.objectContaining({ path: "agents", message: expect.stringContaining(message) }),
    ]),
  );
  const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
  expect(migrated.partiallyValid).toBeUndefined();
  expect(raw).toEqual(original);
  expect(migrated.sourceConfig).toBeDefined();
  expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
  expect(
    migrateLegacyConfig(migrated.sourceConfig, {
      sourceConfigBeforeMigrations: migrated.sourceConfig,
    }).changes,
  ).toEqual([]);
  return migrated;
}

describe("Code Mode JavaScript config migration", () => {
  it.each(["entries", "list"])(
    "removes retired language settings from global config and the %s roster without changing activation or limits",
    (roster) => {
      const agent = {
        tools: { codeMode: { enabled: false, languages: ["typescript"], timeoutMs: 2500 } },
      };
      const raw = {
        tools: { codeMode: { languages: null, maxOutputBytes: 4096 } },
        agents: agentRoster(roster, agent),
      };
      const migrated = checkMigration(raw, "languages", "JavaScript only");
      expect(migrated.config?.tools?.codeMode).toEqual({ maxOutputBytes: 4096 });
      expect(migrated.config?.agents?.entries?.main?.tools?.codeMode).toEqual({
        enabled: false,
        timeoutMs: 2500,
      });
    },
  );
});

describe("Code Mode executor config migration", () => {
  it.each(["entries", "list"])(
    "preserves an explicit QuickJS runtime and newer executor selections in the %s roster",
    (roster) => {
      const agent = {
        tools: {
          codeMode: {
            enabled: false,
            runtime: "quickjs-wasi",
            executor: "node",
            timeoutMs: 2500,
          },
        },
      };
      const raw = {
        tools: {
          codeMode: { enabled: "auto", runtime: "quickjs-wasi", maxOutputBytes: 4096 },
        },
        plugins: roster === "entries" ? { enabled: false } : { allow: ["openai"] },
        agents: agentRoster(roster, agent),
      };
      const migrated = checkMigration(raw, "runtime", "tools.codeMode.executor");
      expect(migrated.config?.tools?.codeMode).toEqual({
        enabled: "auto",
        executor: "quickjs",
        maxOutputBytes: 4096,
      });
      expect(migrated.config?.agents?.entries?.main?.tools?.codeMode).toEqual({
        enabled: false,
        executor: "node",
        timeoutMs: 2500,
      });
      expect(migrated.sourceConfig?.plugins).toEqual(raw.plugins);
    },
  );
});
