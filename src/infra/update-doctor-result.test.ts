import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import {
  captureUpdateDoctorConfigWrites,
  consumeUpdatePostInstallDoctorResult,
  createDeferredConfiguredPluginRepairDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  normalizeUpdatePostInstallDoctorWarnings,
  recordUpdateDoctorConfigMigration,
  recordUpdateDoctorConfigWriteRefusal,
  writeUpdatePostInstallDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "./update-doctor-result.js";

const resultPaths: string[] = [];
function resultFile() {
  const file = createUpdatePostInstallDoctorResultPath();
  resultPaths.push(file);
  return file;
}

async function consume(file: string, expected: unknown) {
  await expect(consumeUpdatePostInstallDoctorResult(file)).resolves.toEqual(expected);
  await expect(fs.access(file)).rejects.toThrow();
}

async function consumeRaw(result: unknown, expected: unknown) {
  const file = resultFile();
  await fs.writeFile(file, JSON.stringify(result), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await consume(file, expected);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(resultPaths.splice(0).map((resultPath) => fs.rm(resultPath, { force: true })));
});

describe("post-install doctor result IPC", () => {
  it.each(["file", "stdout"])("round-trips advisory evidence over %s", async (destination) => {
    const result = {
      ...createDeferredConfiguredPluginRepairDoctorResult(["deferred repair"]),
      configHash: "b".repeat(64),
      warnings: ["plugin/example: version probe timed out"],
      deferredInspectionCheckIds: ["core/doctor/new-target-inspection", "target:Inspection_Check"],
    };
    if (destination === "stdout") {
      const output: string[] = [];
      vi.stubEnv("VITEST", "false");
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
      try {
        await writeUpdatePostInstallDoctorResult({ resultPath: "-", result });
      } finally {
        write.mockRestore();
      }
      expect(output.join("")).toMatch(
        new RegExp(`^${UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV}=`),
      );
      expect(JSON.parse(output.join("").split("=").slice(1).join("="))).toEqual(result);
      return;
    }
    const resultPath = resultFile();
    await writeUpdatePostInstallDoctorResult({ resultPath, result });

    await consume(resultPath, result);
  });

  it("bounds distinct warnings before writing and after reading", async () => {
    const resultPath = resultFile();
    const warnings = [
      "   ",
      ...Array.from({ length: 40 }, (_, index) => `Warning ${index}. ${"x".repeat(600)}`),
    ];
    const expected = Array.from({ length: 32 }, (_, index) => `Warning ${index}. …`);
    const repeatedWarnings = warnings.flatMap((warning) => [warning, ` ${warning} `]);

    await writeUpdatePostInstallDoctorResult({
      resultPath,
      result: { status: "ok", warnings: repeatedWarnings },
    });
    const bounded = { status: "ok", warnings: expected };
    expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual(bounded);
    await consume(resultPath, bounded);

    await consumeRaw({ status: "ok", warnings: repeatedWarnings }, bounded);
  });

  it("bounds warnings at complete sentences or fields instead of cutting recovery advice", () => {
    const first = "Doctor and plugin maintenance remain pending.";
    const detail = `Owner: ${"x".repeat(480)}. Stop the Gateway through its service manager before retrying.`;
    expect(normalizeUpdatePostInstallDoctorWarnings([`${first} ${detail}`, "   "])).toEqual([
      `${first} …`,
    ]);
    expect(normalizeUpdatePostInstallDoctorWarnings([`pid: 4242\n${"y".repeat(600)}`])).toEqual([
      "pid: 4242 …",
    ]);
    expect(normalizeUpdatePostInstallDoctorWarnings([`${"w".repeat(499)}🤔`])).toEqual([
      "Warning detail omitted because it exceeds the display limit.",
    ]);
    const [bounded] = normalizeUpdatePostInstallDoctorWarnings([`${"w".repeat(498)}. More text.`]);
    expect(bounded).toBe("Warning detail omitted because it exceeds the display limit.");
  });

  it("keeps a complete leading field when its description exceeds the warning limit", () => {
    const field = "/state/external-agent/openclaw-agent.sqlite:";
    const warning = `${field} ${"verify the workspace before restoring the agent ".repeat(20)}`;
    expect(normalizeUpdatePostInstallDoctorWarnings([warning])).toEqual([`${field} …`]);
  });

  it("keeps a complete diagnostic code after a long source path", () => {
    const sourcePath = `/state/${"profile/".repeat(24)}sessions.json`;
    const field = `${sourcePath}: [retained_plugin_receipt_superseded]`;
    const warning = `${field} ${"verify the source before restoring the agent ".repeat(20)}`;
    expect(normalizeUpdatePostInstallDoctorWarnings([warning])).toEqual([`${field} …`]);
  });

  it.each([
    { ids: "missing-array" },
    { ids: [" "] },
    { ids: Array.from({ length: 129 }, () => "core/doctor/example") },
    { ids: [`core/doctor/${"x".repeat(256)}`] },
  ])(
    "keeps malformed selector evidence unknown without changing Doctor status ($ids)",
    async ({ ids }) => {
      await consumeRaw({ status: "ok", deferredInspectionCheckIds: ids }, { status: "ok" });
    },
  );

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

  it("rejects malformed advisory payloads and consumes the file", async () => {
    await consumeRaw(
      {
        status: "advisory",
        advisory: {
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          message: "forged advisory",
          details: [],
        },
      },
      null,
    );
  });
});
