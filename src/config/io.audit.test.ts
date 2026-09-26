// Covers config audit reporting for files, paths, and values.
import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  readRecentConfigAuditRecords,
  resolveLegacyConfigAuditLogPath,
  sanitizeConfigAuditRecord,
  scrubConfigAuditLog,
} from "./io.audit.js";
import type { ConfigAuditRecord } from "./io.audit.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";

type ExpectedConfigObserveAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.observe";
  phase: "read";
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  exists: boolean;
  valid: boolean;
  hash: string | null;
  bytes: number | null;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  suspicious: string[];
  lastKnownGoodHash: string | null;
  lastKnownGoodBytes: number | null;
  lastKnownGoodMtimeMs: number | null;
  lastKnownGoodCtimeMs: number | null;
  lastKnownGoodDev: string | null;
  lastKnownGoodIno: string | null;
  lastKnownGoodMode: number | null;
  lastKnownGoodNlink: number | null;
  lastKnownGoodUid: number | null;
  lastKnownGoodGid: number | null;
  lastKnownGoodGatewayMode: string | null;
  backupHash: string | null;
  backupBytes: number | null;
  backupMtimeMs: number | null;
  backupCtimeMs: number | null;
  backupDev: string | null;
  backupIno: string | null;
  backupMode: number | null;
  backupNlink: number | null;
  backupUid: number | null;
  backupGid: number | null;
  backupGatewayMode: string | null;
  clobberedPath: string | null;
  restoredFromBackup: boolean;
  restoredBackupPath: string | null;
  restoreErrorCode: string | null;
  restoreErrorMessage: string | null;
};

type ConfigObserveAuditRecord = Extract<ConfigAuditRecord, { event: "config.observe" }>;

expectTypeOf<ConfigObserveAuditRecord>().toMatchTypeOf<ExpectedConfigObserveAuditRecord>();
expectTypeOf<ExpectedConfigObserveAuditRecord>().toMatchTypeOf<ConfigObserveAuditRecord>();

type ExpectedConfigWriteAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.write";
  result: "rename" | "copy-fallback" | "failed" | "rejected";
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  watchMode: boolean;
  watchSession: string | null;
  watchCommand: string | null;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string | null;
  previousBytes: number | null;
  nextBytes: number | null;
  previousDev: string | null;
  nextDev: string | null;
  previousIno: string | null;
  nextIno: string | null;
  previousMode: number | null;
  nextMode: number | null;
  previousNlink: number | null;
  nextNlink: number | null;
  previousUid: number | null;
  nextUid: number | null;
  previousGid: number | null;
  nextGid: number | null;
  changedPathCount: number | null;
  changedPaths?: string[];
  origin?: import("./io.types.js").ConfigWriteAuditOrigin;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  errorCode?: string;
  errorMessage?: string;
};

expectTypeOf<
  Extract<ConfigAuditRecord, { event: "config.write" }>
>().toMatchTypeOf<ExpectedConfigWriteAuditRecord>();
expectTypeOf<ExpectedConfigWriteAuditRecord>().toMatchTypeOf<
  Extract<ConfigAuditRecord, { event: "config.write" }>
>();

function createAuditRecordBase(configPath: string, argv?: string[]) {
  return createConfigWriteAuditRecordBase({
    configPath,
    env: {} as NodeJS.ProcessEnv,
    existsBefore: true,
    previousHash: "prev-hash",
    nextHash: "next-hash",
    previousBytes: 12,
    nextBytes: 24,
    previousMetadata: {
      dev: "10",
      ino: "11",
      mode: 0o600,
      nlink: 1,
      uid: 501,
      gid: 20,
    },
    changedPathCount: 1,
    hasMetaBefore: true,
    hasMetaAfter: true,
    gatewayModeBefore: "local",
    gatewayModeAfter: "local",
    suspicious: [],
    now: "2026-04-07T08:00:00.000Z",
    ...(argv
      ? {
          processInfo: {
            pid: 101,
            ppid: 99,
            cwd: "/work",
            argv,
            execArgv: [],
          },
        }
      : {}),
  });
}

function createRenameAuditRecord(home: string) {
  return finalizeConfigWriteAuditRecord({
    base: createAuditRecordBase(path.join(home, ".openclaw", "openclaw.json")),
    result: "rename",
    nextMetadata: {
      dev: "12",
      ino: "13",
      mode: 0o600,
      nlink: 1,
      uid: 501,
      gid: 20,
    },
  });
}

function readLegacyAuditLog(home: string): unknown[] {
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  return fs
    .readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function requireAuditRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected audit JSONL record");
  }
  return value as Record<string, unknown>;
}

describe("config io audit helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-audit-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  it("sanitizes external records without adding write-process fields", () => {
    const record = sanitizeConfigAuditRecord({
      ts: "2026-07-18T00:00:00.000Z",
      source: "config-io",
      event: "config.external",
      detectedBy: "watch",
      configPath: "/tmp/openclaw.json",
      previousHash: "previous",
      nextHash: null,
      valid: false,
      issues: ["gateway.port: expected number"],
    });

    expect(record).not.toHaveProperty("argv");
    expect(record).not.toHaveProperty("execArgv");
    expect(record).toHaveProperty("issues", ["gateway.port: expected number"]);
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  it('ignores literal "undefined" home env values when choosing the audit log path', async () => {
    const home = await suiteRootTracker.make("home");
    const auditPath = resolveLegacyConfigAuditLogPath(
      {
        HOME: "undefined",
        USERPROFILE: "null",
        OPENCLAW_HOME: "undefined",
      } as NodeJS.ProcessEnv,
      () => home,
    );
    expect(auditPath).toBe(path.join(home, ".openclaw", "logs", "config-audit.jsonl"));
    expect(auditPath.startsWith(path.resolve("undefined"))).toBe(false);
  });

  it("formats overwrite warnings with hash transition and backup path", () => {
    expect(
      formatConfigOverwriteLogMessage({
        configPath: "/tmp/openclaw.json",
        previousHash: "prev-hash",
        nextHash: "next-hash",
        changedPathCount: 3,
      }),
    ).toBe(
      "Config overwrite: /tmp/openclaw.json (sha256 prev-hash -> next-hash, backup=/tmp/openclaw.json.bak, changedPaths=3)",
    );
  });

  it("captures watch markers and next stat metadata for successful writes", () => {
    const base = createConfigWriteAuditRecordBase({
      configPath: "/tmp/openclaw.json",
      env: {
        OPENCLAW_WATCH_MODE: "1",
        OPENCLAW_WATCH_SESSION: "watch-session-1",
        OPENCLAW_WATCH_COMMAND: "gateway --force",
      } as NodeJS.ProcessEnv,
      existsBefore: true,
      previousHash: "prev-hash",
      nextHash: "next-hash",
      previousBytes: 12,
      nextBytes: 24,
      previousMetadata: {
        dev: "10",
        ino: "11",
        mode: 0o600,
        nlink: 1,
        uid: 501,
        gid: 20,
      },
      changedPathCount: 2,
      hasMetaBefore: false,
      hasMetaAfter: true,
      gatewayModeBefore: null,
      gatewayModeAfter: "local",
      suspicious: ["missing-meta-before-write"],
      now: "2026-04-07T08:00:00.000Z",
      processInfo: {
        pid: 101,
        ppid: 99,
        cwd: "/work",
        argv: ["node", "openclaw"],
        execArgv: ["--loader"],
      },
    });
    const record = finalizeConfigWriteAuditRecord({
      base,
      result: "rename",
      nextMetadata: {
        dev: "12",
        ino: "13",
        mode: 0o600,
        nlink: 1,
        uid: 501,
        gid: 20,
      },
    });

    expect(record.watchMode).toBe(true);
    expect(record.watchSession).toBe("watch-session-1");
    expect(record.watchCommand).toBe("gateway --force");
    expect(record.nextHash).toBe("next-hash");
    expect(record.nextBytes).toBe(24);
    expect(record.nextDev).toBe("12");
    expect(record.nextIno).toBe("13");
    expect(record.result).toBe("rename");
  });

  it("drops next-file metadata and preserves error details for failed writes", () => {
    const base = createAuditRecordBase("/tmp/openclaw.json");
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const record = finalizeConfigWriteAuditRecord({
      base,
      result: "failed",
      err,
    });

    expect(record.result).toBe("failed");
    expect(record.nextHash).toBeNull();
    expect(record.nextBytes).toBeNull();
    expect(record.nextDev).toBeNull();
    expect(record.errorCode).toBe("ENOSPC");
    expect(record.errorMessage).toBe("disk full");
  });

  it("appends audit entries off-thread and retains them after canonical close", async () => {
    const home = await suiteRootTracker.make("append");
    const record = createRenameAuditRecord(home);

    const mainSql = observeMainThreadSql();
    try {
      await appendConfigAuditRecord({ env: {}, homedir: () => home, record });
      await closeOpenClawStateDatabaseAsync();
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }

    const records = listConfigAuditRecordsForTests({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });
    expect(records).toHaveLength(1);
    const written = requireAuditRecord(records[0]);
    expect(written.event).toBe("config.write");
    expect(written.result).toBe("rename");
    expect(written.nextHash).toBe("next-hash");
  });

  it("reads a bounded newest-first audit window for Doctor provenance", async () => {
    const home = await suiteRootTracker.make("recent");
    const first = createRenameAuditRecord(home);
    const second = {
      ...first,
      ts: "2026-04-07T08:01:00.000Z",
      previousHash: first.nextHash,
      nextHash: "newest-hash",
    };
    await appendConfigAuditRecord({ env: {}, homedir: () => home, record: first });
    await appendConfigAuditRecord({ env: {}, homedir: () => home, record: second });

    const recent = readRecentConfigAuditRecords({ env: {}, homedir: () => home, limit: 1 });

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ nextHash: "newest-hash" });
  });

  it("redacts structured audit records before persistence", async () => {
    const home = await suiteRootTracker.make("append-redacted");
    const record = finalizeConfigWriteAuditRecord({
      base: {
        ...createAuditRecordBase(path.join(home, ".openclaw", "openclaw.json")),
        suspicious: [
          "provider returned ya29.fake-access-token-with-enough-length",
          "plugin returned AIzaSyD-very-real-looking-google-api-key-123",
        ],
      },
      result: "failed",
      err: Object.assign(new Error("payload contained abcd-efgh-ijkl-mnop"), { code: "EFAIL" }),
    });

    await appendConfigAuditRecord({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      record,
    });

    const raw = JSON.stringify(
      listConfigAuditRecordsForTests({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      }),
    );
    expect(raw).not.toContain("AIzaSyD-very-real-looking");
    expect(raw).not.toContain("ya29.fake-access-token");
    expect(raw).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("caps caller-supplied processInfo argv at 8 entries before redaction", () => {
    const longArgv = [
      "node",
      "openclaw",
      "--api-key",
      "secret",
      "--port",
      "8080",
      "--bind",
      "lan",
      "--leaks-here-token",
      "this-must-not-land-in-audit-1234567890",
    ];
    const base = createConfigWriteAuditRecordBase({
      configPath: "/tmp/openclaw.json",
      env: {} as NodeJS.ProcessEnv,
      existsBefore: true,
      previousHash: "prev",
      nextHash: "next",
      previousBytes: 1,
      nextBytes: 2,
      previousMetadata: {
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
      },
      changedPathCount: 0,
      hasMetaBefore: true,
      hasMetaAfter: true,
      gatewayModeBefore: "local",
      gatewayModeAfter: "local",
      suspicious: [],
      now: "2026-04-30T00:00:00.000Z",
      processInfo: {
        pid: 1,
        ppid: 1,
        cwd: "/work",
        argv: longArgv,
        execArgv: [],
      },
    });
    expect(base.argv).toHaveLength(8);
    expect(base.argv).not.toContain("this-must-not-land-in-audit-1234567890");
    expect(base.argv).not.toContain("--leaks-here-token");
  });

  it("redacts processInfo.argv when explicitly supplied to createConfigWriteAuditRecordBase", () => {
    const base = createConfigWriteAuditRecordBase({
      configPath: "/tmp/openclaw.json",
      env: {} as NodeJS.ProcessEnv,
      existsBefore: true,
      previousHash: "prev",
      nextHash: "next",
      previousBytes: 1,
      nextBytes: 2,
      previousMetadata: {
        dev: null,
        ino: null,
        mode: null,
        nlink: null,
        uid: null,
        gid: null,
      },
      changedPathCount: 0,
      hasMetaBefore: true,
      hasMetaAfter: true,
      gatewayModeBefore: "local",
      gatewayModeAfter: "local",
      suspicious: [],
      now: "2026-04-30T00:00:00.000Z",
      processInfo: {
        pid: 1,
        ppid: 1,
        cwd: "/work",
        argv: ["node", "openclaw", "--token", "leaked-but-not-anymore-12345"],
        execArgv: [],
      },
    });
    expect(base.argv).toEqual(["node", "openclaw", "--token", "***"]);
  });

  it.each([
    [
      "inline known secret",
      ["openclaw", "--token=fake", "--port=8080"],
      ["openclaw", "--token=***", "--port=8080"],
    ],
    [
      "custom credential suffix",
      ["openclaw", "--tenant-credential", "fake", "--bind", "lan"],
      ["openclaw", "--tenant-credential", "***", "--bind", "lan"],
    ],
    [
      "underscore key suffix",
      ["openclaw", "--provider_api_key", "fake"],
      ["openclaw", "--provider_api_key", "***"],
    ],
    [
      "dash-leading secret value",
      ["openclaw", "--password", "-fake"],
      ["openclaw", "--password", "***"],
    ],
    [
      "password alias covered by the secret suffix matcher",
      ["openclaw", "--passwd", "fake"],
      ["openclaw", "--passwd", "***"],
    ],
    ["secret flag without a value", ["openclaw", "--token"], ["openclaw", "--token"]],
    [
      "sensitive config set positional value",
      ["openclaw", "config", "set", "channels.slack.token", "secret-value"],
      ["openclaw", "config", "set", "channels.slack.token", "***"],
    ],
    [
      "sensitive config set value after boolean option",
      ["openclaw", "config", "set", "--json", "channels.slack.token", '"secret-value"'],
      ["openclaw", "config", "set", "--json", "channels.slack.token", "***"],
    ],
    [
      "sensitive config set value after root value option",
      ["openclaw", "config", "set", "--profile", "work", "channels.slack.token", "secret-value"],
      ["openclaw", "config", "set", "--profile", "work", "channels.slack.token", "***"],
    ],
    [
      "sensitive config set value after option before subcommand",
      ["openclaw", "config", "--profile", "work", "set", "channels.slack.token", "secret-value"],
      ["openclaw", "config", "--profile", "work", "set", "channels.slack.token", "***"],
    ],
    [
      "sensitive config set value after config parent option",
      [
        "openclaw",
        "config",
        "--section",
        "channels",
        "set",
        "channels.slack.token",
        "secret-value",
      ],
      ["openclaw", "config", "--section", "channels", "set", "channels.slack.token", "***"],
    ],
    [
      "sensitive config set value when a root option value is config",
      ["openclaw", "--profile", "config", "config", "set", "channels.slack.token", "secret-value"],
      ["openclaw", "--profile", "config", "config", "set", "channels.slack.token", "***"],
    ],
    [
      "sensitive config set value after interleaved option",
      ["openclaw", "config", "set", "channels.slack.token", "--strict-json", '"secret-value"'],
      ["openclaw", "config", "set", "channels.slack.token", "--strict-json", "***"],
    ],
    [
      "independent option terminators for command and positional scanning",
      [
        "openclaw",
        "config",
        "--",
        "set",
        "--section=channels",
        "channels.slack.token",
        "secret-value",
      ],
      ["openclaw", "config", "--", "set", "--section=channels", "channels.slack.token", "***"],
    ],
    [
      "dash-leading positional after inline parent option and terminator",
      ["openclaw", "config", "--profile=work", "set", "--", "channels.slack.token", "--dash-value"],
      ["openclaw", "config", "--profile=work", "set", "--", "channels.slack.token", "***"],
    ],
    [
      "batch JSON after both positionals and an option terminator",
      [
        "openclaw",
        "config",
        "set",
        "ui.theme",
        "dark",
        "--",
        '--batch-json={"value":"secret-value"}',
      ],
      ["openclaw", "config", "set", "ui.theme", "dark", "--", "--batch-json=***"],
    ],
    [
      "non-set command whose first positional is set",
      ["openclaw", "config", "get", "set", "channels.slack.token", "visible-value"],
      ["openclaw", "config", "get", "set", "channels.slack.token", "visible-value"],
    ],
    [
      "config set batch JSON",
      [
        "openclaw",
        "config",
        "set",
        "--batch-json",
        '[{"path":"channels.slack.token","value":"secret-value"}]',
      ],
      ["openclaw", "config", "set", "--batch-json", "***"],
    ],
    [
      "config provider env assignment",
      ["openclaw", "config", "set", "--provider-env", "KEY=secret-value"],
      ["openclaw", "config", "set", "--provider-env", "***"],
    ],
    [
      "inline config provider env assignment",
      ["openclaw", "config", "set", "--provider-env=KEY=secret-value"],
      ["openclaw", "config", "set", "--provider-env=***"],
    ],
  ])("redacts $0 in persisted audit process info", (_name, argv, expected) => {
    expect(createAuditRecordBase("/tmp/openclaw.json", argv).argv).toEqual(expected);
  });

  it("also accepts flattened audit record params from legacy call sites", async () => {
    const home = await suiteRootTracker.make("append-flat");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      ...record,
    });

    const records = listConfigAuditRecordsForTests({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });
    expect(records).toHaveLength(1);
    const written = requireAuditRecord(records[0]);
    expect(written.event).toBe("config.write");
    expect(written.result).toBe("rename");
    expect(written.nextHash).toBe("next-hash");
  });

  it("redacts historical config audit entries while preserving file and directory modes", async () => {
    const home = await suiteRootTracker.make("scrub-historical");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(auditPath), 0o755);
    const unredactedRecord = {
      ts: "2026-05-02T00:03:48.471Z",
      source: "config-io",
      event: "config.write",
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      pid: 1590563,
      ppid: 1590548,
      cwd: home,
      argv: [
        "/usr/bin/node",
        "/usr/local/bin/openclaw.mjs",
        "config",
        "set",
        "channels.slack.botToken",
        "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
      ],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      suspicious: [],
      result: "rename",
    };
    const alreadyRedactedRecord = {
      ts: "2026-05-08T12:00:00.000Z",
      source: "config-io",
      event: "config.write",
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      pid: 1,
      ppid: 1,
      cwd: home,
      argv: ["/usr/bin/node", "/usr/local/bin/openclaw.mjs", "config", "set", "ui.theme", "dark"],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      suspicious: [],
      result: "rename",
    };
    fs.writeFileSync(
      auditPath,
      `${JSON.stringify(unredactedRecord)}\n${JSON.stringify(alreadyRedactedRecord)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    const env = {} as NodeJS.ProcessEnv;
    const result = await scrubConfigAuditLog({
      env,
      homedir: () => home,
    });

    expect(result).toEqual({ scanned: 2, rewritten: 1, skipped: 0, aborted: false });
    const after = readLegacyAuditLog(home);
    expect(after).toHaveLength(2);
    const firstAfter = requireAuditRecord(after[0]);
    const secondAfter = requireAuditRecord(after[1]);
    const firstArgv = firstAfter.argv as string[];
    expect(firstArgv).toHaveLength(unredactedRecord.argv.length);
    expect(firstArgv.slice(0, 5)).toEqual(unredactedRecord.argv.slice(0, 5));
    expect(firstArgv[5]).not.toContain("real-bot-token");
    expect(JSON.stringify(firstAfter)).not.toContain("xoxb-real-bot-token");
    expect(firstAfter.ts).toBe(unredactedRecord.ts);
    expect(firstAfter.suspicious).toEqual([]);
    expect(secondAfter.argv).toEqual(alreadyRedactedRecord.argv);

    if (process.platform !== "win32") {
      expect(fs.statSync(auditPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(auditPath)).mode & 0o777).toBe(0o755);
    }

    const second = await scrubConfigAuditLog({
      env,
      homedir: () => home,
    });
    expect(second).toEqual({ scanned: 2, rewritten: 0, skipped: 0, aborted: false });
  });

  it("returns zero counts and does not create the audit file when none exists", async () => {
    const home = await suiteRootTracker.make("scrub-missing");
    const result = await scrubConfigAuditLog({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });
    expect(result).toEqual({ scanned: 0, rewritten: 0, skipped: 0, aborted: false });
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  it("preserves malformed lines verbatim and counts them as skipped", async () => {
    const home = await suiteRootTracker.make("scrub-malformed");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const malformed = "{this is not valid json";
    const validUnredacted = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: ["node", "openclaw.mjs", "config", "set", "x", "xoxb-bad-token-1234567890abcdef"],
    };
    fs.writeFileSync(auditPath, `${malformed}\n${JSON.stringify(validUnredacted)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });

    const result = await scrubConfigAuditLog({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result).toEqual({ scanned: 2, rewritten: 1, skipped: 1, aborted: false });
    const text = fs.readFileSync(auditPath, "utf-8");
    expect(text.split("\n")[0]).toBe(malformed);
    expect(text).not.toContain("xoxb-bad-token");
  });

  it("does not write when dryRun is true even if records would change", async () => {
    const home = await suiteRootTracker.make("scrub-dryrun");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const unredacted = {
      ts: "2026-05-02T00:03:48.471Z",
      argv: [
        "node",
        "openclaw.mjs",
        "config",
        "set",
        "channels.slack.appToken",
        "xapp-1-A1B2C3-1234567890-abcdef0123456789abcdef0123456789",
      ],
      execArgv: [],
    };
    const original = `${JSON.stringify(unredacted)}\n`;
    fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });

    const result = await scrubConfigAuditLog({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      dryRun: true,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 1, skipped: 0, aborted: false });
    const text = fs.readFileSync(auditPath, "utf-8");
    expect(text).toBe(original);
    expect(text).toContain("xapp-1-A1B2C3");
  });

  it.each(["read", "write"] as const)(
    "preserves concurrent appends after the scrub %s and cleans up staged output",
    async (phase) => {
      const home = await suiteRootTracker.make("scrub-race-after-temp-write");
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
      const unredacted = {
        ts: "2026-05-02T00:03:48.471Z",
        argv: [
          "node",
          "openclaw.mjs",
          "config",
          "set",
          "channels.slack.botToken",
          "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
        ],
        execArgv: [],
      };
      const appended = {
        ts: "2026-05-02T00:04:00.000Z",
        argv: ["node", "openclaw.mjs", "config", "set", "theme", "dark"],
        execArgv: [],
      };
      const original = `${JSON.stringify(unredacted)}\n`;
      const appendedLine = `${JSON.stringify(appended)}\n`;
      fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });
      const readFile = fsPromises.readFile.bind(fsPromises);
      const writeFile = fsPromises.writeFile.bind(fsPromises);
      const hook =
        phase === "read"
          ? vi.spyOn(fsPromises, "readFile").mockImplementationOnce(async (file, options) => {
              const bytes = await readFile(file, options);
              await fsPromises.appendFile(auditPath, appendedLine, "utf-8");
              return bytes;
            })
          : vi
              .spyOn(fsPromises, "writeFile")
              .mockImplementationOnce(async (file, bytes, options) => {
                await writeFile(file, bytes, options);
                await fsPromises.appendFile(auditPath, appendedLine, "utf-8");
              });
      try {
        const result = await scrubConfigAuditLog({ env: {}, homedir: () => home });
        expect(result.aborted).toBe(true);
        expect(result.rewritten).toBeGreaterThan(0);
      } finally {
        hook.mockRestore();
      }
      const after = fs.readFileSync(auditPath, "utf-8");
      expect(after).toBe(`${original}${appendedLine}`);
      expect(after).toContain("xoxb-real-bot-token");
      expect(fs.readdirSync(path.dirname(auditPath))).toEqual(["config-audit.jsonl"]);
    },
  );
});
