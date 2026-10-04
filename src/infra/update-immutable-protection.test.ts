import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { fingerprintConfigSnapshotAuthoredConfig } from "../config/config-journal-snapshot.js";
import {
  appendConfigAuditRecordSync,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
} from "../config/io.audit.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { resolveConfigStatMetadata } from "../config/io.write-safety.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ImmutableProtectionSnapshotSchema } from "./update-immutable-protection-schema.js";
import {
  assertImmutableProtectionUnchanged,
  captureImmutableProtection,
  verifyImmutableProtection,
} from "./update-immutable-protection.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

async function fixture() {
  const root = fs.realpathSync(temporary.make("openclaw-immutable-protection-"));
  const configPath = path.join(root, "openclaw.json");
  const env = { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
  const config = {
    gateway: { mode: "local", auth: { mode: "token", token: "synthetic-protected-token" } },
    channels: { telegram: { enabled: true, dmPolicy: "allowlist", allowFrom: ["synthetic-peer"] } },
    meta: { lastTouchedVersion: "2026.9.1" },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  openOpenClawStateDatabase({ env });
  fingerprintConfigSnapshotAuthoredConfig(config, { env });
  const assertCurrent = () => {};
  const snapshot = await captureImmutableProtection({
    configPath,
    stateDir: root,
    env,
    assertCurrent,
  });
  const candidate = {
    pid: 4567,
    generationPath: path.join(root, "releases", "a".repeat(40)),
    startedAtMs: snapshot.capturedAtMs,
    assertCurrent,
  };
  const context = { env, assertCurrent, candidate };
  const migrate = (
    next: unknown,
    options: {
      pid?: number;
      cwd?: string;
      audited?: boolean;
      brokenHash?: boolean;
      foreignOrigin?: boolean;
    } = {},
  ) => {
    const previousRaw = fs.readFileSync(configPath, "utf8");
    const previousMetadata = resolveConfigStatMetadata(fs.statSync(configPath));
    const raw = JSON.stringify(next);
    const stage = `${configPath}.candidate`;
    fs.writeFileSync(stage, raw, { mode: 0o600 });
    fs.renameSync(stage, configPath);
    if (options.audited === false) {
      return;
    }
    appendConfigAuditRecordSync({
      env,
      homedir: () => root,
      record: finalizeConfigWriteAuditRecord({
        base: createConfigWriteAuditRecordBase({
          configPath,
          env,
          existsBefore: true,
          previousHash: options.brokenHash ? "f".repeat(64) : hashConfigRaw(previousRaw),
          nextHash: hashConfigRaw(raw),
          previousBytes: Buffer.byteLength(previousRaw),
          nextBytes: Buffer.byteLength(raw),
          previousMetadata,
          changedPathCount: 1,
          hasMetaBefore: true,
          hasMetaAfter: true,
          gatewayModeBefore: "local",
          gatewayModeAfter: "local",
          suspicious: [],
          origin: options.foreignOrigin ? "config-rpc" : "doctor",
          processInfo: {
            pid: options.pid ?? candidate.pid,
            ppid: 1,
            cwd: options.cwd ?? candidate.generationPath,
            argv: ["node", path.join(candidate.generationPath, "dist/index.js"), "gateway"],
            execArgv: [],
          },
        }),
        result: "rename",
        nextMetadata: resolveConfigStatMetadata(fs.statSync(configPath)),
      }),
    });
  };
  const additive = () => ({
    ...config,
    channels: {
      telegram: { ...config.channels.telegram, legacyWebhook: { port: 8787, host: "127.0.0.1" } },
    },
    meta: {
      lastTouchedVersion: "2026.9.9",
      migrations: { webhookListeners: { telegram: [["channels", "telegram", "legacyWebhook"]] } },
    },
  });
  return { root, configPath, config, snapshot, context, migrate, additive };
}

describe("immutable activation protected identities", () => {
  it("accepts candidate-authored additive startup migration across config inode replacement while preserving policy and state", async () => {
    const test = await fixture();
    const durable = structuredClone(test.snapshot);
    expect(JSON.stringify(durable)).not.toContain("synthetic-protected-token");
    expect(ImmutableProtectionSnapshotSchema.parse(durable)).toEqual(test.snapshot);
    expect(verifyImmutableProtection(test.snapshot, test.context)).toEqual({
      configMigrated: false,
    });
    test.migrate(test.additive());
    test.migrate({ ...test.additive(), logging: { level: "info" } });
    expect(verifyImmutableProtection(durable, test.context)).toEqual({ configMigrated: true });
    expect(fs.readFileSync(test.configPath, "utf8")).toContain("legacyWebhook");
  });

  it.each([
    "unaudited",
    "foreign PID",
    "foreign generation",
    "hash gap",
    "foreign origin",
  ] as const)("refuses an additive rewrite with %s provenance", async (kind) => {
    const test = await fixture();
    test.migrate(test.additive(), {
      audited: kind !== "unaudited",
      ...(kind === "foreign PID" ? { pid: 9999 } : {}),
      ...(kind === "foreign generation" ? { cwd: test.root } : {}),
      brokenHash: kind === "hash gap",
      foreignOrigin: kind === "foreign origin",
    });
    expect(() => verifyImmutableProtection(test.snapshot, test.context)).toThrow(
      /audit|receipt|candidate/u,
    );
  });

  it.each([
    "changed value",
    "removed value",
    "added policy",
    "changed channel permissions",
  ] as const)(
    "refuses candidate-authored %s without hiding the healthy candidate's files",
    async (kind) => {
      const test = await fixture();
      const next: Record<string, unknown> = test.additive();
      if (kind === "changed value") {
        next.meta = { lastTouchedVersion: "2026.9.9", migration: true };
        next.channels = {
          telegram: { ...test.config.channels.telegram, allowFrom: ["other-peer"] },
        };
      } else if (kind === "removed value") {
        delete next.channels;
      } else if (kind === "added policy") {
        next.tools = { exec: { mode: "full" } };
      } else {
        next.channels = { telegram: { ...test.config.channels.telegram, groupPolicy: "open" } };
      }
      test.migrate(next);
      expect(() => verifyImmutableProtection(test.snapshot, test.context)).toThrow(
        /policy-preserving/u,
      );
      expect(JSON.parse(fs.readFileSync(test.configPath, "utf8"))).toEqual(next);
    },
  );

  it("rejects a foreign writer in the middle of an otherwise candidate-owned chain", async () => {
    const test = await fixture();
    test.migrate(test.additive());
    test.migrate({ ...test.additive(), logging: { level: "info" } }, { pid: 9999 });
    test.migrate({ ...test.additive(), logging: { level: "info", file: "synthetic.log" } });
    expect(() => verifyImmutableProtection(test.snapshot, test.context)).toThrow(/candidate/u);
  });

  it("refuses config changes during drain before any cutover", async () => {
    const test = await fixture();
    test.migrate(test.additive());
    expect(() => assertImmutableProtectionUnchanged(test.snapshot, test.context)).toThrow(
      /before immutable cutover/u,
    );
  });

  it("refuses database replacement while allowing its normal content writes", async () => {
    const test = await fixture();
    writeConfigMachineState("immutable-protection-test", "written after capture", {
      env: test.context.env,
    });
    expect(() => assertImmutableProtectionUnchanged(test.snapshot, test.context)).not.toThrow();
    await closeOpenClawStateDatabaseAsync();
    const database = test.snapshot.state.path;
    const replacement = `${database}.replacement`;
    fs.copyFileSync(database, replacement);
    fs.renameSync(replacement, database);
    expect(() => verifyImmutableProtection(test.snapshot, test.context)).toThrow(
      /state database identity/u,
    );
  });

  it("never recreates an unavailable private journal key from the root updater", async () => {
    const test = await fixture();
    const key = path.join(test.root, "config-journal-fingerprint.key");
    fs.unlinkSync(key);
    await expect(
      captureImmutableProtection({
        configPath: test.configPath,
        stateDir: test.root,
        ...test.context,
      }),
    ).rejects.toThrow(/fingerprints are unavailable/u);
    expect(fs.existsSync(key)).toBe(false);
  });

  it("rechecks live candidate authority after protection reads", async () => {
    const test = await fixture();
    let checks = 0;
    test.context.candidate.assertCurrent = () => {
      if (++checks > 1) {
        throw new Error("candidate boot changed");
      }
    };
    expect(() => verifyImmutableProtection(test.snapshot, test.context)).toThrow(
      "candidate boot changed",
    );
  });
});
