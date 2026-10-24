import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTransientSqliteBackupPath, isVolatileBackupPath } from "./backup-volatile-filter.js";

const stateDir = "/opt/openclaw/state";
const plan = { stateDirs: [stateDir] };
const expectVolatile = (relative: string, expected: boolean, root = stateDir) =>
  expect(
    isVolatileBackupPath(`${root}${root.includes("\\") ? "\\" : "/"}${relative}`, {
      stateDirs: [root],
    }),
  ).toBe(expected);

describe("isVolatileBackupPath", () => {
  it.each([
    [`${stateDir}/ipc/gateway.sock`, true],
    [`${stateDir}/audit/system-agent.jsonl.migrated.raw`, true],
    [`${stateDir}/logs/config-audit.jsonl.migrated.raw.quarantined-2026-09-17`, true],
    [`${stateDir}/audit/crestodian.jsonl.migrated.2.raw.quarantined-copy`, true],
    [`${stateDir}/logs/config-audit.jsonl.migrated`, false],
    [`${stateDir}/logs/config-audit.jsonl.migrated.quarantined-copy`, false],
    [`${stateDir}/delivery-queue/pending.tmp`, true],
    [`${stateDir}/session-delivery-queue/pending.tmp`, true],
    [`${stateDir}/browser/openclaw/user-data/SingletonCookie`, true],
    [`${stateDir}/browser/openclaw/user-data/SingletonLock`, true],
    [`${stateDir}/browser/openclaw/user-data/SingletonSocket`, true],
    [`${stateDir}/sandbox/skills-workspaces/workspace-main`, true],
    [`${stateDir}/cache/control-ui-assets/generation/assets/app.js`, true],
    [`${stateDir}/tmp/plugin-captures/instance/captures/source.js`, true],
    [`${stateDir}/tmp/plugin-captures-saved/source.js`, false],
    [`${stateDir}/sessions/s-abc/meta.json`, false],
    [`${stateDir}/agents/main/sessions/sessions.json`, false],
    [`${stateDir}/cron/jobs.json`, false],
    [`${stateDir}/cron/runs/2026-01-01/job.json`, false],
    [`${stateDir}/browser/openclaw/user-data/Preferences`, false],
    [`${stateDir}/browser/openclaw/user-data/nested/SingletonSocket`, false],
    [`${stateDir}/browser/openclaw/SingletonSocket`, false],
    [`${stateDir}/sandbox/registry.json`, false],
    [`${stateDir}/sandbox/workspaces/workspace-main/README.md`, false],
    [`${stateDir}/cache/other-product/artifact.bin`, false],
    [`${stateDir}/config.json`, false],
    [`${stateDir}/delivery-queue/subdir/job.json`, true],
    [`${stateDir}/delivery-queue/README.md`, false],
    ["/tmp/delivery-queue/file.json", false],
  ])("classifies %s as volatile=%s", (p, expected) => {
    expect(isVolatileBackupPath(p, plan)).toBe(expected);
  });
  it("does not skip transient extensions without a state anchor", () => {
    expect(isVolatileBackupPath("/any/path/daemon.sock", { stateDirs: [] })).toBe(false);
  });

  it("does not match paths that escape the anchor via `..`", () => {
    for (const relative of [
      "sessions/../config.jsonl",
      "cron/runs/../jobs.log",
      "logs/../notes.jsonl",
    ]) {
      expectVolatile(relative, false);
    }
  });

  it("normalizes Windows-style separators before anchor checks", () => {
    const winStateDir = "C:\\openclaw\\state";
    for (const relative of [
      "sessions\\s-abc\\transcript.jsonl",
      "agents\\main\\sessions\\s.jsonl",
      "cron\\runs\\2026\\job.jsonl",
      "browser\\openclaw\\user-data\\SingletonLock",
      "sandbox\\skills-workspaces\\workspace-main",
      "logs\\config-audit.jsonl.migrated.raw.quarantined-copy",
    ]) {
      expectVolatile(relative, true, winStateDir);
    }
    expectVolatile("sessions\\..\\config.jsonl", false, winStateDir);
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
  it.each([
    "memory/main.sqlite.generation-writer.sqlite-wal",
    "memory/main.sqlite.generation-lock.sqlite-journal",
    "memory/main.sqlite.tmp-11111111-2222-3333-4444-555555555555",
  ])("classifies transient reindex state: %s", (filePath) => {
    expect(isTransientSqliteBackupPath(filePath)).toBe(true);
  });

  it.each(["plugins/dedicated/cache.lock.sqlite", "plugins/dedicated/lock.sqlite"])(
    "preserves durable SQLite state: %s",
    (filePath) => {
      expect(isTransientSqliteBackupPath(filePath)).toBe(false);
    },
  );
});
