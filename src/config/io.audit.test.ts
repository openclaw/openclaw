import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  enqueueConfigAuditRecord,
  finalizeConfigWriteAuditRecord,
  readRecentConfigAuditRecords,
  resolveLegacyConfigAuditLogPath,
  sanitizeConfigAuditRecord,
  scrubConfigAuditLog,
} from "./io.audit.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";

const metadata = { dev: "10", ino: "11", mode: 0o600, nlink: 1, uid: 501, gid: 20 };

function redactionCase(name: string, prefix: string[], value: string, redacted = "***") {
  return [name, [...prefix, value], [...prefix, redacted]] as const;
}
function configCase(name: string, args: string[], value = "secret-value", redacted = "***") {
  return redactionCase(name, ["openclaw", "config", ...args], value, redacted);
}

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
    previousMetadata: metadata,
    changedPathCount: 1,
    hasMetaBefore: true,
    hasMetaAfter: true,
    gatewayModeBefore: "local",
    gatewayModeAfter: "local",
    suspicious: [],
    now: "2026-04-07T08:00:00.000Z",
    processInfo: argv ? { pid: 101, ppid: 99, cwd: "/work", argv, execArgv: [] } : undefined,
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
    nextMetadata: { ...metadata, dev: "12", ino: "13" },
  });
}

const historicalRecord = {
  ts: "2026-05-02T00:03:48.471Z",
  suspicious: [],
  argv: [
    ..."/usr/bin/node /usr/local/bin/openclaw.mjs config set channels.slack.botToken".split(" "),
    "xoxb-real-bot-token-1234567890abcdef0123456789abcdef",
  ],
  execArgv: ["--disable-warning=ExperimentalWarning"],
};

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
  const env = { HOME: "undefined", USERPROFILE: "null", OPENCLAW_HOME: "undefined" };
  const auditPath = resolveLegacyConfigAuditLogPath(env, () => home);
  expect(auditPath).toBe(path.join(home, ".openclaw", "logs", "config-audit.jsonl"));
  expect(auditPath.startsWith(path.resolve("undefined"))).toBe(false);
});

it("drains queued observations without main-thread SQL and reads the newest audit record", async () => {
  const home = await suiteRootTracker.make("recent");
  const first = createRenameAuditRecord(home);
  const second = {
    ...first,
    ts: "2026-04-07T08:01:00.000Z",
    previousHash: first.nextHash,
    nextHash: "newest-hash",
  };
  await appendConfigAuditRecord({ env: {}, homedir: () => home, record: first });
  const work = new AsyncWorkScope();
  const sql = observeMainThreadSql();
  try {
    work.run(() => enqueueConfigAuditRecord({ env: {}, homedir: () => home, record: second }));
    await work.drain();
    sql.expectIdle();
  } finally {
    sql.restore();
  }

  const recent = readRecentConfigAuditRecords({ env: {}, homedir: () => home, limit: 1 });

  expect(recent).toEqual([expect.objectContaining({ nextHash: "newest-hash" })]);
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

  const deps = { env: {}, homedir: () => home };
  await appendConfigAuditRecord({ ...deps, record });
  const raw = JSON.stringify(listConfigAuditRecordsForTests(deps));
  expect(raw).not.toContain("AIzaSyD-very-real-looking");
  expect(raw).not.toContain("ya29.fake-access-token");
  expect(raw).not.toContain("abcd-efgh-ijkl-mnop");
});

it("caps caller-supplied processInfo argv at 8 entries before redaction", () => {
  const longArgv = [
    ..."node openclaw --api-key secret --port 8080 --bind lan".split(" "),
    "--leaks-here-token",
    "this-must-not-land-in-audit-1234567890",
  ];
  const base = createAuditRecordBase("/tmp/openclaw.json", longArgv);
  expect(base.argv).toHaveLength(8);
  expect(base.argv).not.toContain("this-must-not-land-in-audit-1234567890");
  expect(base.argv).not.toContain("--leaks-here-token");
});

it.each([
  redactionCase("dash-leading secret value", ["openclaw", "--password"], "-fake"),
  configCase("boolean option", ["set", "--json", "channels.slack.token"], '"secret-value"'),
  configCase("root value option", ["set", "--profile", "work", "channels.slack.token"]),
  configCase("option before subcommand", ["--profile", "work", "set", "channels.slack.token"]),
  redactionCase(
    "root option value named config",
    ["openclaw", "--profile", "config", "config", "set", "channels.slack.token"],
    "secret-value",
  ),
  configCase("independent terminators", [
    "--",
    "set",
    "--section=channels",
    "channels.slack.token",
  ]),
  configCase(
    "dash-leading positional after inline option",
    ["--profile=work", "set", "--", "channels.slack.token"],
    "--dash-value",
  ),
  configCase(
    "batch JSON after both positionals and an option terminator",
    ["set", "ui.theme", "dark", "--"],
    '--batch-json={"value":"secret-value"}',
    "--batch-json=***",
  ),
  configCase(
    "config set batch JSON",
    ["set", "--batch-json"],
    '[{"path":"channels.slack.token","value":"secret-value"}]',
  ),
])("redacts $0 in persisted audit process info", (_name, argv, expected) => {
  expect(createAuditRecordBase("/tmp/openclaw.json", [...argv]).argv).toEqual(expected);
});

it("redacts historical config audit entries while preserving file and directory modes", async () => {
  const home = await suiteRootTracker.make("scrub-historical");
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(auditPath), 0o755);
  const unredactedRecord = historicalRecord;
  const alreadyRedactedRecord = {
    ...unredactedRecord,
    argv: ["openclaw", "config", "set", "ui.theme", "dark"],
  };
  fs.writeFileSync(
    auditPath,
    `{not json\n${JSON.stringify(unredactedRecord)}\n${JSON.stringify(alreadyRedactedRecord)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );

  const deps = { env: {}, homedir: () => home };
  const result = await scrubConfigAuditLog(deps);

  expect(result).toEqual({ scanned: 3, rewritten: 1, skipped: 1, aborted: false });
  const [invalid, ...records] = fs.readFileSync(auditPath, "utf8").trim().split("\n");
  expect(invalid).toBe("{not json");
  expect(records.map((line) => JSON.parse(line))).toEqual([
    { ...unredactedRecord, argv: [...unredactedRecord.argv.slice(0, 5), "***"] },
    alreadyRedactedRecord,
  ]);

  if (process.platform !== "win32") {
    expect(fs.statSync(auditPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(auditPath)).mode & 0o777).toBe(0o755);
  }

  const second = await scrubConfigAuditLog(deps);
  expect(second).toEqual({ scanned: 3, rewritten: 0, skipped: 1, aborted: false });
});

it("returns zero counts and does not create the audit file when none exists", async () => {
  const home = await suiteRootTracker.make("scrub-missing");
  const result = await scrubConfigAuditLog({ env: {}, homedir: () => home });
  expect(result).toEqual({ scanned: 0, rewritten: 0, skipped: 0, aborted: false });
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  expect(fs.existsSync(auditPath)).toBe(false);
});

it("preserves concurrent appends after the scrub write and cleans up staged output", async () => {
  const home = await suiteRootTracker.make("scrub-race-after-temp-write");
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const unredacted = historicalRecord;
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
});
