import { expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  assertPluginCohortDatabaseRestoreRecords,
  assertPluginCohortDatabaseRestoreMigrations,
  type PluginCohortDatabaseMigrationRow,
} from "./update-plugin-cohort-records.js";
import type { PluginCohortRecovery } from "./update-plugin-cohort-schema.js";

const record = (version: string): PluginInstallRecord => ({ source: "npm", version });
const baseline = { fixture: record("1"), other: record("9") };
const index = (records: Record<string, PluginInstallRecord>) =>
  JSON.stringify({ index: { installRecords: records } });
const publications: PluginCohortRecovery["publications"] = [
  { kind: "records", records: [{ pluginId: "fixture", before: record("1"), after: record("2") }] },
  { kind: "records", records: [{ pluginId: "fixture", before: record("2"), after: record("3") }] },
];

it("allows the owned final generation and an already restored baseline", () => {
  for (const current of [baseline, { ...baseline, fixture: record("3") }]) {
    expect(() =>
      assertPluginCohortDatabaseRestoreRecords(publications, index(baseline), index(current)),
    ).not.toThrow();
  }
  expect(() =>
    assertPluginCohortDatabaseRestoreRecords(
      publications,
      index({ ...baseline, fixture: record("0") }),
      index({ ...baseline, fixture: record("3") }),
    ),
  ).toThrow("no matching database backup preimage");
});

it("allows owned installations and removals", () => {
  for (const [before, after] of [
    [undefined, record("1")],
    [record("1"), undefined],
  ]) {
    expect(() =>
      assertPluginCohortDatabaseRestoreRecords(
        [{ kind: "records", records: [{ pluginId: "fixture", before, after }] }],
        index(before ? { fixture: before } : {}),
        index(after ? { fixture: after } : {}),
      ),
    ).not.toThrow();
  }
});

it.each([
  { ...baseline, added: record("1") },
  { ...baseline, other: record("10") },
  { fixture: baseline.fixture },
  { ...baseline, fixture: record("4") },
  { ...baseline, ["__proto__"]: record("1") },
])("refuses to erase a later independent plugin change: %j", (current) => {
  expect(() =>
    assertPluginCohortDatabaseRestoreRecords(publications, index(baseline), index(current)),
  ).toThrow("changed outside the update");
});

it("refuses discontinuous ownership and invalid canonical records", () => {
  expect(() =>
    assertPluginCohortDatabaseRestoreRecords(
      [publications[0]!, publications[0]!],
      index(baseline),
      index({ ...baseline, fixture: record("3") }),
    ),
  ).toThrow("changed between update publications");
  for (const [before, current] of [
    ["null", index(baseline)],
    [index(baseline), "{}"],
  ]) {
    expect(() => assertPluginCohortDatabaseRestoreRecords([], before, current)).toThrow(
      "invalid canonical plugin install records",
    );
  }
});

it("compares migration decisions before physical restore, including absence and later writers", () => {
  const row = (report_json: string): PluginCohortDatabaseMigrationRow => ({
    id: "deferred-plugin-migration:fixture",
    started_at: 1,
    finished_at: null,
    status: "pending",
    report_json,
  });
  const before = row("baseline");
  const owned = row("owned");
  const migrationRow = (raw: PluginCohortDatabaseMigrationRow) => ({
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    status: "pending" as const,
    reportJson: raw.report_json,
  });
  const migrationPublications: PluginCohortRecovery["publications"] = [
    {
      kind: "plugin-migrations",
      rows: [{ pluginId: "fixture", before: migrationRow(before), after: migrationRow(owned) }],
    },
  ];
  for (const current of [[before], [owned]]) {
    expect(() =>
      assertPluginCohortDatabaseRestoreMigrations(migrationPublications, [before], current),
    ).not.toThrow();
  }
  for (const current of [
    [],
    [row("independent")],
    [owned, { ...row("added"), id: "deferred-plugin-migration:added" }],
  ]) {
    expect(() =>
      assertPluginCohortDatabaseRestoreMigrations(migrationPublications, [before], current),
    ).toThrow("changed outside the update");
  }
  expect(() =>
    assertPluginCohortDatabaseRestoreMigrations(migrationPublications, [], [owned]),
  ).toThrow("no matching database backup preimage");
  const installation: PluginCohortRecovery["publications"] = [
    { kind: "plugin-migrations", rows: [{ pluginId: "fixture", after: migrationRow(owned) }] },
  ];
  for (const current of [[], [owned]]) {
    expect(() =>
      assertPluginCohortDatabaseRestoreMigrations(installation, [], current),
    ).not.toThrow();
  }
  expect(() =>
    assertPluginCohortDatabaseRestoreMigrations([], [before], [row("independent")]),
  ).toThrow("changed outside the update");
  expect(() =>
    assertPluginCohortDatabaseRestoreMigrations(
      [...migrationPublications, ...migrationPublications],
      [before],
      [owned],
    ),
  ).toThrow("changed between update publications");
});
