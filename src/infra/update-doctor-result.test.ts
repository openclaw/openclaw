import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import {
  captureUpdateDoctorConfigWrites,
  consumeUpdatePostInstallDoctorResult,
  createDeferredConfiguredPluginRepairDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  getUpdateDoctorConfigWriteAuthority,
  recordUpdateDoctorConfigMigration,
  recordUpdateDoctorConfigWrite,
  recordUpdateDoctorConfigWriteRefusal,
  writeUpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";

const resultPaths: string[] = [];

afterEach(async () => {
  await Promise.all(resultPaths.splice(0).map((resultPath) => fs.rm(resultPath, { force: true })));
});

describe("post-install doctor result IPC", () => {
  it.each([
    { status: "ok" as const, configHash: "unchanged" },
    { status: "ok" as const, warnings: ["plugin/example: version probe timed out"] },
    { status: "error" as const, configHash: "a".repeat(64), configInputHash: "b".repeat(64) },
    {
      status: "error" as const,
      failureFacts: [
        { check: "doctor", code: "doctor-failed", message: "Required migration failed" },
      ],
    },
    {
      status: "ok" as const,
      configChanges: [
        { kind: "key" as const, key: "agents" },
        { kind: "key" as const, key: "meta" },
        { kind: "migration" as const, message: "Moved agents.list to agents.entries." },
      ],
    },
    {
      status: "error" as const,
      configWriteRefusal: {
        reason: "include-ownership",
        message: "Repair agents in its included file.",
        keys: ["agents"],
      },
    },
    {
      ...createDeferredConfiguredPluginRepairDoctorResult(["deferred repair"]),
      configHash: "b".repeat(64),
      warnings: ["plugin/example: version probe timed out"],
    },
    createDeferredConfiguredPluginRepairDoctorResult(["legacy child advisory"]),
  ])("round-trips $status results and consumes the file", async (result) => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    await writeUpdatePostInstallDoctorResult({ resultPath, result });

    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual(result);
    await expect(fs.access(resultPath)).rejects.toThrow();
  });

  it("bounds warning count and length before writing and after reading", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    const warnings = [
      "   ",
      ...Array.from({ length: 40 }, (_, index) => `${index}: ${"x".repeat(600)}`),
    ];
    const expected = warnings.slice(1, 33).map((warning) => warning.slice(0, 500));

    await writeUpdatePostInstallDoctorResult({ resultPath, result: { status: "ok", warnings } });
    expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({
      status: "ok",
      warnings: expected,
    });
    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual({
      status: "ok",
      warnings: expected,
    });

    await fs.writeFile(resultPath, JSON.stringify({ status: "ok", warnings }));
    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual({
      status: "ok",
      warnings: expected,
    });
  });

  it("retains complete config evidence beyond health-warning limits", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    const configChanges: UpdateDoctorConfigChange[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "migration",
      message: `${index}: ${"migration detail ".repeat(40)}`,
    }));
    await writeUpdatePostInstallDoctorResult({
      resultPath,
      result: { status: "ok", configChanges },
    });
    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual({
      status: "ok",
      configChanges,
    });
  });

  it("keeps committed migration notes and the first refusal scoped to one Doctor run", async () => {
    const refusal = {
      reason: "include-ownership",
      message: "Repair the included file.",
      keys: ["tools", "agents", "tools"],
    };
    await captureUpdateDoctorConfigWrites("/synthetic/openclaw.json", async (capture) => {
      recordUpdateDoctorConfigMigration("Moved legacy agent entries.");
      recordUpdateDoctorConfigMigration("Moved legacy agent entries.");
      recordUpdateDoctorConfigWriteRefusal(refusal);
      recordUpdateDoctorConfigWriteRefusal({
        reason: "validation",
        message: "Later refusal.",
        keys: [],
      });
      expect(capture.configChanges).toEqual([
        { kind: "migration", message: "Moved legacy agent entries." },
      ]);
      expect(capture.configWriteRefusal).toEqual({ ...refusal, keys: ["agents", "tools"] });
    });
    await captureUpdateDoctorConfigWrites("/synthetic/other.json", async (capture) => {
      expect(capture.configChanges).toEqual([]);
      expect(capture.configWriteRefusal).toBeUndefined();
    });
  });

  it("carries current authority to included writes and advances only the root input hash", async () => {
    const configPath = "/synthetic/openclaw.json";
    const initialHash = "a".repeat(64);
    const committedHash = "b".repeat(64);
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("Requester authority revoked.");
      }
    };
    expect(getUpdateDoctorConfigWriteAuthority(configPath)).toBeUndefined();
    await captureUpdateDoctorConfigWrites(
      configPath,
      async () => {
        expect(getUpdateDoctorConfigWriteAuthority(configPath)).toEqual({
          inputHash: initialHash,
          assertCurrent,
        });
        expect(getUpdateDoctorConfigWriteAuthority("/synthetic/agents.json")).toEqual({
          assertCurrent,
        });
        recordUpdateDoctorConfigWrite(
          configPath,
          initialHash,
          committedHash,
          {},
          '{"tools":{"profile":"full"}}',
        );
        expect(getUpdateDoctorConfigWriteAuthority(configPath)).toEqual({
          inputHash: committedHash,
          assertCurrent,
        });
        revoked = true;
        expect(() =>
          getUpdateDoctorConfigWriteAuthority("/synthetic/agents.json")?.assertCurrent(),
        ).toThrow("Requester authority revoked.");
      },
      { inputHash: initialHash, assertCurrent },
    );
    expect(getUpdateDoctorConfigWriteAuthority(configPath)).toBeUndefined();
  });

  it.each([
    { configChanges: [{ kind: "key", key: 7 }] },
    { configChanges: [{ kind: "migration", message: false }] },
    { configChanges: [{ kind: "unrecognized", key: "agents" }] },
    { configWriteRefusal: { reason: "validation", message: "Invalid config.", keys: [7] } },
  ])("rejects malformed config evidence: %j", async (evidence) => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    await fs.writeFile(resultPath, JSON.stringify({ status: "ok", ...evidence }), {
      mode: 0o600,
      flag: "wx",
    });
    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toBeNull();
  });

  it("rejects result paths outside the secure OpenClaw temp root", async () => {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    const resultPath = path.join(
      `${tempRoot}-outside`,
      `openclaw-update-doctor-${process.pid}-00000000-0000-4000-8000-000000000000.json`,
    );

    await expect(
      writeUpdatePostInstallDoctorResult({
        resultPath,
        result: createDeferredConfiguredPluginRepairDoctorResult(["deferred repair"]),
      }),
    ).rejects.toThrow("Unsafe post-install doctor result path");
    await expect(fs.access(resultPath)).rejects.toThrow();
  });

  it("accepts newer child advisory copy without letting malformed optional facts change its outcome", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "advisory",
        failureFacts: [{ check: "doctor", message: 42 }],
        advisory: {
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          message: "newer child advisory wording",
          details: ["deferred repair"],
        },
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual(
      createDeferredConfiguredPluginRepairDoctorResult(["deferred repair"]),
    );
  });

  it("rejects malformed advisory payloads and consumes the file", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "advisory",
        advisory: {
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          message: "forged advisory",
          details: [],
        },
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toBeNull();
    await expect(fs.access(resultPath)).rejects.toThrow();
  });
});
