// Tests volatile path filtering for backup operations.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTransientSqliteBackupPath, isVolatileBackupPath } from "./backup-volatile-filter.js";

const stateDir = "/opt/openclaw/state";
const plan = { stateDirs: [stateDir] };

describe("isVolatileBackupPath", () => {
  it.each([[`${stateDir}/tmp/pending.tmp`, true]])(
    "classifies %s as volatile=%s",
    (p, expected) => {
      expect(isVolatileBackupPath(p, plan)).toBe(expected);
    },
  );

  it("does not match paths that escape the anchor via `..`", () => {
    // `/opt/openclaw/state/sessions/../config.jsonl` resolves to
    // `/opt/openclaw/state/config.jsonl`, which is NOT inside sessions/.
    expect(isVolatileBackupPath(`${stateDir}/sessions/../config.jsonl`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/cron/runs/../jobs.log`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/logs/../notes.jsonl`, plan)).toBe(false);
  });

  it("normalizes Windows-style separators before anchor checks", () => {
    const winStateDir = "C:\\openclaw\\state";
    const winPlan = { stateDirs: [winStateDir] };
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\s-abc\\transcript.jsonl`, winPlan)).toBe(
      true,
    );
    expect(isVolatileBackupPath(`${winStateDir}\\agents\\main\\sessions\\s.jsonl`, winPlan)).toBe(
      true,
    );
    expect(isVolatileBackupPath(`${winStateDir}\\cron\\runs\\2026\\job.jsonl`, winPlan)).toBe(true);
    expect(
      isVolatileBackupPath(`${winStateDir}\\browser\\openclaw\\user-data\\SingletonLock`, winPlan),
    ).toBe(true);
    expect(
      isVolatileBackupPath(`${winStateDir}\\sandbox\\skills-workspaces\\workspace-main`, winPlan),
    ).toBe(true);
    expect(
      isVolatileBackupPath(
        `${winStateDir}\\logs\\config-audit.jsonl.migrated.raw.quarantined-copy`,
        winPlan,
      ),
    ).toBe(true);
    // `..` escape via backslashes must also be rejected.
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\..\\config.jsonl`, winPlan)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not resolve a Windows anchor into a relative POSIX directory",
    () => {
      const outside = path.resolve(
        "C:/openclaw/state/logs/config-audit.jsonl.migrated.raw.quarantined-copy",
      );
      expect(isVolatileBackupPath(outside, { stateDirs: ["C:\\openclaw\\state"] })).toBe(false);
    },
  );
});

describe("isTransientSqliteBackupPath", () => {
  it.each(["memory/main.sqlite.tmp-11111111-2222-3333-4444-555555555555"])(
    "classifies transient reindex state: %s",
    (filePath) => {
      expect(isTransientSqliteBackupPath(filePath)).toBe(true);
    },
  );

  it.each(["tmp/openclaw-502/retained.sqlite"])(
    "preserves durable SQLite state: %s",
    (filePath) => {
      expect(isTransientSqliteBackupPath(filePath)).toBe(false);
    },
  );
});
