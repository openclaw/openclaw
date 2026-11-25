import path from "node:path";
import { expect, it } from "vitest";
import { isTransientSqliteBackupPath, isVolatileBackupPath } from "./backup-volatile-filter.js";

const stateDir = "/opt/openclaw/state";
const plan = { stateDirs: [stateDir] };
const expectVolatile = (relative: string, expected: boolean, root = stateDir) =>
  expect(isVolatileBackupPath(`${root}/${relative}`, { stateDirs: [root] })).toBe(expected);

it.each([
  [`${stateDir}/ipc/gateway.sock`, true],
  [`${stateDir}/audit/system-agent.jsonl.migrated.raw`, true],
  [`${stateDir}/logs/config-audit.jsonl.migrated.raw.quarantined-2026-09-17`, true],
  [`${stateDir}/audit/crestodian.jsonl.migrated.2.raw.quarantined-copy`, true],
  [`${stateDir}/logs/config-audit.jsonl.migrated`, false],
  [`${stateDir}/logs/config-audit.jsonl.migrated.quarantined-copy`, false],
  [`${stateDir}/browser/openclaw/user-data/SingletonSocket`, true],
  [`${stateDir}/sandbox/skills-workspaces/workspace-main`, true],
  [`${stateDir}/cache/control-ui-assets/generation/assets/app.js`, true],
  [`${stateDir}/tmp/plugin-captures/instance/captures/source.js`, true],
  [`${stateDir}/tmp/plugin-captures-saved/source.js`, false],
  [`${stateDir}/sessions/s-abc/meta.json`, false],
  [`${stateDir}/browser/openclaw/user-data/Preferences`, false],
  [`${stateDir}/browser/openclaw/user-data/nested/SingletonSocket`, false],
  [`${stateDir}/sandbox/workspaces/workspace-main/README.md`, false],
  [`${stateDir}/cache/other-product/artifact.bin`, false],
  [`${stateDir}/delivery-queue/subdir/job.json`, true],
  [`${stateDir}/delivery-queue/README.md`, false],
  ["/tmp/delivery-queue/file.json", false],
])("classifies %s as volatile=%s", (p, expected) => {
  expect(isVolatileBackupPath(p, plan)).toBe(expected);
});
it("does not skip transient extensions without a state anchor", () => {
  expect(isVolatileBackupPath("/any/path/daemon.sock", { stateDirs: [] })).toBe(false);
});

it("normalizes parent traversal before matching volatile directories", () => {
  expectVolatile("sessions/../config.jsonl", false);
});

it("normalizes Windows-style separators before anchor checks", () => {
  const winStateDir = "C:\\openclaw\\state";
  expectVolatile("sessions\\s-abc\\transcript.jsonl", true, winStateDir);
  expectVolatile("sessions\\..\\config.jsonl", false, winStateDir);
});

it.runIf(process.platform !== "win32")("keeps Windows anchors absolute on POSIX", () => {
  const outside = path.resolve(
    "C:/openclaw/state/logs/config-audit.jsonl.migrated.raw.quarantined-copy",
  );
  expect(isVolatileBackupPath(outside, { stateDirs: ["C:\\openclaw\\state"] })).toBe(false);
});
it.each([
  "memory/main.sqlite.generation-writer.sqlite-wal",
  "memory/main.sqlite.tmp-11111111-2222-3333-4444-555555555555",
])("classifies transient reindex state: %s", (filePath) => {
  expect(isTransientSqliteBackupPath(filePath)).toBe(true);
});

it("preserves durable SQLite lock state", () => {
  expect(isTransientSqliteBackupPath("plugins/dedicated/cache.lock.sqlite")).toBe(false);
});
