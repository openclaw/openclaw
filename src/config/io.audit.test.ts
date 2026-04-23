import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  AUDIT_ARGV_EXTRA_PATTERNS,
  appendConfigAuditRecord,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  resolveConfigAuditLogPath,
  resolveConfigAuditProcessInfo,
} from "./io.audit.js";

function createAuditRecordBase(configPath: string) {
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

function readAuditLog(home: string): unknown[] {
  const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
  return fs
    .readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("config io audit helpers", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-audit-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it('ignores literal "undefined" home env values when choosing the audit log path', async () => {
    const home = await suiteRootTracker.make("home");
    const auditPath = resolveConfigAuditLogPath(
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

  it("appends JSONL audit entries to the resolved audit path", async () => {
    const home = await suiteRootTracker.make("append");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      fs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      record,
    });

    const records = readAuditLog(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "config.write",
      result: "rename",
      nextHash: "next-hash",
    });
  });

  it("also accepts flattened audit record params from legacy call sites", async () => {
    const home = await suiteRootTracker.make("append-flat");
    const record = createRenameAuditRecord(home);

    await appendConfigAuditRecord({
      fs,
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      ...record,
    });

    const records = readAuditLog(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "config.write",
      result: "rename",
      nextHash: "next-hash",
    });
  });
});

describe("resolveConfigAuditProcessInfo argv redaction", () => {
  it("returns processInfo as-is when provided (override path, no redaction)", () => {
    const info = resolveConfigAuditProcessInfo({
      pid: 1,
      ppid: 2,
      cwd: "/work",
      argv: ["node", "openclaw", "--token", "abc123"],
      execArgv: [],
    });
    expect(info.argv).toEqual(["node", "openclaw", "--token", "abc123"]);
  });

  it("handles empty argv without error", () => {
    const info = resolveConfigAuditProcessInfo({
      pid: 1,
      ppid: 2,
      cwd: "/work",
      argv: [],
      execArgv: [],
    });
    expect(info.argv).toEqual([]);
  });
});

describe("AUDIT_ARGV_EXTRA_PATTERNS redaction", () => {
  function redact(input: string): string {
    return redactSensitiveText(input, {
      mode: "tools",
      patterns: [...getDefaultRedactPatterns(), ...AUDIT_ARGV_EXTRA_PATTERNS],
    });
  }

  it("redacts --token value (space-separated)", () => {
    expect(redact("openclaw --token abc123")).not.toContain("abc123");
    expect(redact("openclaw --token abc123")).toContain("--token");
  });

  it("redacts --token=value (equals format)", () => {
    expect(redact("openclaw --token=abc123")).not.toContain("abc123");
    expect(redact("openclaw --token=abc123")).toContain("--token");
  });

  it("redacts --bot-token value", () => {
    expect(redact("openclaw --bot-token xoxb-secret")).not.toContain("xoxb-secret");
  });

  it("redacts --gateway-token value", () => {
    expect(redact("openclaw --gateway-token mytoken")).not.toContain("mytoken");
  });

  it("redacts --password=value (equals format)", () => {
    expect(redact("openclaw --password=hunter2")).not.toContain("hunter2");
    expect(redact("openclaw --password=hunter2")).toContain("--password");
  });

  it("redacts --app-token, --access-token, --custom-api-key values", () => {
    expect(redact("openclaw --app-token appval")).not.toContain("appval");
    expect(redact("openclaw --access-token accval")).not.toContain("accval");
    expect(redact("openclaw --custom-api-key ck123")).not.toContain("ck123");
  });

  it("does not redact non-secret flag values", () => {
    const result = redact("openclaw gateway start --mode local --port 3000");
    expect(result).toContain("local");
    expect(result).toContain("3000");
  });
});

