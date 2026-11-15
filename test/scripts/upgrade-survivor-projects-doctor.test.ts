import { describe, expect, it } from "vitest";
import {
  assertProjectsDoctorResult,
  assertProjectsInventory,
} from "../../scripts/e2e/lib/upgrade-survivor/projects-doctor.mjs";

const inventory = {
  rows: [{ id: "retained", source: "registered", updated_at_ms: 123 }],
  schema: [{ name: "projects", sql: "fixture schema" }],
  workspace: "/fixture/workspace",
  sentinels: { "/fixture/workspace/PROJECTS-PROOF.txt": "original" },
  sqliteFamily: { main: "database", "-wal": "wal" },
  configHash: "config",
  retainedSnapshots: [],
};
const clean = { ok: true, checksRun: 1, checksSkipped: 27, findings: [] };

describe("Projects upgrade Doctor evidence", () => {
  it("accepts the selected check and preserved state without pinning unrelated check counts", () => {
    expect(() =>
      assertProjectsDoctorResult(clean, inventory, structuredClone(inventory)),
    ).not.toThrow();
    expect(() =>
      assertProjectsDoctorResult({ ...clean, checksSkipped: 28 }, inventory, inventory),
    ).not.toThrow();
  });

  it.each([
    { ...clean, ok: false },
    { ...clean, checksRun: 0 },
    { ...clean, checksRun: 2 },
    { ...clean, findings: [{ checkId: "core/doctor/project-clone-shape", severity: "warning" }] },
    { ...clean, findings: [{ checkId: "core/doctor/lint-selection", severity: "error" }] },
  ])("rejects a skipped, failed, or incorrectly selected Doctor result %#", (report) => {
    expect(() => assertProjectsDoctorResult(report, inventory, inventory)).toThrow();
  });

  it.each([
    { rows: [] },
    { rows: [{ id: "retained", source: "registered", updated_at_ms: 124 }] },
    { schema: [] },
    { workspace: "/fixture/other" },
    { sentinels: {} },
  ])("rejects changed persisted inventory or files %#", (change) => {
    expect(() => assertProjectsInventory({ ...inventory, ...change }, inventory)).toThrow();
  });

  it.each([
    { sqliteFamily: { main: "changed", "-wal": "wal" } },
    { sqliteFamily: { main: "database" } },
    { configHash: "rewritten" },
    { retainedSnapshots: ["/fixture/cache/openclaw-sqlite-readonly-retained"] },
  ])("rejects Doctor mutation or incomplete snapshot disposal %#", (change) => {
    expect(() =>
      assertProjectsDoctorResult(clean, inventory, { ...inventory, ...change }),
    ).toThrow();
  });
});
