import { expect, it } from "vitest";
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

const migrations = [
  {
    key: "languages",
    message: "JavaScript only",
    global: { languages: null },
    agent: { languages: ["typescript"] },
    globalAfter: {},
    agentAfter: {},
  },
  {
    key: "runtime",
    message: "tools.codeMode.executor",
    global: { enabled: "auto", runtime: "quickjs-wasi" },
    agent: { runtime: "quickjs-wasi", executor: "node" },
    globalAfter: { enabled: "auto", executor: "quickjs" },
    agentAfter: { executor: "node" },
  },
];
const cases = migrations.flatMap((migration) =>
  ["entries", "list"].map((roster) => ({ migration, roster })),
);
it.each(cases)(
  "Code Mode migrates $migration.key in $roster without changing activation or limits",
  ({ migration: entry, roster }) => {
    const globalLimits = { maxOutputBytes: 4096 };
    const agentLimits = { enabled: false, timeoutMs: 2500 };
    const plugins =
      entry.key === "runtime"
        ? { plugins: roster === "entries" ? { enabled: false } : { allow: ["openai"] } }
        : {};
    const raw = {
      tools: { codeMode: { ...globalLimits, ...entry.global } },
      agents: agentRoster(roster, {
        tools: { codeMode: { ...agentLimits, ...entry.agent } },
      }),
      ...plugins,
    };
    const migrated = checkMigration(raw, entry.key, entry.message);
    expect(migrated.config?.tools?.codeMode).toEqual({ ...globalLimits, ...entry.globalAfter });
    expect(migrated.config?.agents?.entries?.main?.tools?.codeMode).toEqual({
      ...agentLimits,
      ...entry.agentAfter,
    });
    if (entry.key === "runtime") {
      expect(migrated.sourceConfig?.plugins).toEqual(plugins.plugins);
    }
  },
);
