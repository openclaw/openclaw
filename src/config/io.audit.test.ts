// Covers config audit reporting for files, paths, and values.
import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  readRecentConfigAuditRecords,
  resolveLegacyConfigAuditLogPath,
  sanitizeConfigAuditRecord,
  scrubConfigAuditLog,
} from "./io.audit.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";

function createAuditRecordBase(
  configPath: string,
  argv?: string[],
  overrides: Partial<Parameters<typeof createConfigWriteAuditRecordBase>[0]> = {},
) {
  return createConfigWriteAuditRecordBase({
    configPath,
    env: {},
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
    ...overrides,
  });
}

function createRenameAuditRecord(home: string) {
  return finalizeConfigWriteAuditRecord({
    base: createAuditRecordBase(path.join(home, ".openclaw", "openclaw.json"), undefined, {
      env: {
        OPENCLAW_WATCH_MODE: "1",
        OPENCLAW_WATCH_SESSION: "watch-session-1",
        OPENCLAW_WATCH_COMMAND: "gateway --force",
      },
    }),
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

function historicalRecord() {
  return {
    ts: "2026-05-02T00:03:48.471Z",
    suspicious: [],
    argv: [
      "/usr/bin/node",
      "/usr/local/bin/openclaw.mjs",
      "config",
      "set",
      "channels.slack.botToken",
      "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
    ],
    execArgv: ["--disable-warning=ExperimentalWarning"],
  };
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
      env: {},
      homedir: () => home,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "config.write",
      result: "rename",
      nextHash: "next-hash",
      nextBytes: 24,
      nextDev: "12",
      nextIno: "13",
      watchMode: true,
      watchSession: "watch-session-1",
      watchCommand: "gateway --force",
    });
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
      env: {},
      homedir: () => home,
      record,
    });

    const raw = JSON.stringify(
      listConfigAuditRecordsForTests({
        env: {},
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
    const base = createAuditRecordBase("/tmp/openclaw.json", longArgv);
    expect(base.argv).toHaveLength(8);
    expect(base.argv).not.toContain("this-must-not-land-in-audit-1234567890");
    expect(base.argv).not.toContain("--leaks-here-token");
  });

  it.each([
    [
      "inline known secret",
      ["openclaw", "--token=fake", "--port=8080"],
      ["openclaw", "--token=***", "--port=8080"],
    ],

    [
      "dash-leading secret value",
      ["openclaw", "--password", "-fake"],
      ["openclaw", "--password", "***"],
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
      "sensitive config set value when a root option value is config",
      ["openclaw", "--profile", "config", "config", "set", "channels.slack.token", "secret-value"],
      ["openclaw", "--profile", "config", "config", "set", "channels.slack.token", "***"],
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
  ])("redacts $0 in persisted audit process info", (_name, argv, expected) => {
    expect(createAuditRecordBase("/tmp/openclaw.json", argv).argv).toEqual(expected);
  });

  it("redacts historical config audit entries while preserving file and directory modes", async () => {
    const home = await suiteRootTracker.make("scrub-historical");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(auditPath), 0o755);
    const unredactedRecord = historicalRecord();
    const alreadyRedactedRecord = {
      ...unredactedRecord,
      argv: ["openclaw", "config", "set", "ui.theme", "dark"],
    };
    fs.writeFileSync(
      auditPath,
      `{not json\n${JSON.stringify(unredactedRecord)}\n${JSON.stringify(alreadyRedactedRecord)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    const env = {} as NodeJS.ProcessEnv;
    const result = await scrubConfigAuditLog({
      env,
      homedir: () => home,
    });

    expect(result).toEqual({ scanned: 3, rewritten: 1, skipped: 1, aborted: false });
    expect(fs.readFileSync(auditPath, "utf8").split("\n")[0]).toBe("{not json");
    const after = fs
      .readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line));
    expect(after).toEqual([
      { ...unredactedRecord, argv: [...unredactedRecord.argv.slice(0, 5), "***"] },
      alreadyRedactedRecord,
    ]);

    if (process.platform !== "win32") {
      expect(fs.statSync(auditPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(auditPath)).mode & 0o777).toBe(0o755);
    }

    const second = await scrubConfigAuditLog({
      env,
      homedir: () => home,
    });
    expect(second).toEqual({ scanned: 3, rewritten: 0, skipped: 1, aborted: false });
  });

  it("returns zero counts and does not create the audit file when none exists", async () => {
    const home = await suiteRootTracker.make("scrub-missing");
    const result = await scrubConfigAuditLog({
      env: {},
      homedir: () => home,
    });
    expect(result).toEqual({ scanned: 0, rewritten: 0, skipped: 0, aborted: false });
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  it("does not write when dryRun is true even if records would change", async () => {
    const home = await suiteRootTracker.make("scrub-dryrun");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const unredacted = historicalRecord();
    const original = `${JSON.stringify(unredacted)}\n`;
    fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });

    const result = await scrubConfigAuditLog({
      env: {},
      homedir: () => home,
      dryRun: true,
    });

    expect(result).toEqual({ scanned: 1, rewritten: 1, skipped: 0, aborted: false });
    const text = fs.readFileSync(auditPath, "utf-8");
    expect(text).toBe(original);
    expect(text).toContain("xoxb-real-bot-token");
  });

  it.each(["write"] as const)(
    "preserves concurrent appends after the scrub %s and cleans up staged output",
    async () => {
      const home = await suiteRootTracker.make("scrub-race-after-temp-write");
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
      const unredacted = historicalRecord();
      const appended = { ...unredacted, argv: ["openclaw", "config", "set", "theme", "dark"] };
      const original = `${JSON.stringify(unredacted)}\n`;
      const appendedLine = `${JSON.stringify(appended)}\n`;
      fs.writeFileSync(auditPath, original, { encoding: "utf-8", mode: 0o600 });
      const writeFile = fsPromises.writeFile.bind(fsPromises);
      const hook = vi
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
