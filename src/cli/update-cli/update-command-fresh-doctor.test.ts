import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { createUpdateRun, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
}));

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.runExec,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveNodeRunner: vi.fn(() => "/usr/bin/node"),
}));

import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";

const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

const updateOptions = {
  root: "/opt/openclaw",
  pluginUpdate,
  freshDoctorRequired: true,
  yes: true,
  json: true,
  timeoutMs: 5_000,
};

const validConfigSnapshot = {
  exists: true,
  valid: true as const,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("post-plugin update readiness", () => {
  beforeEach(() => {
    mocks.readConfig.mockReset().mockResolvedValue(validConfigSnapshot);
    mocks.resolveEntrypoint.mockReset().mockResolvedValue("/opt/openclaw/dist/index.js");
    mocks.runExec.mockReset().mockImplementation(async (_command, args: string[]) => ({
      stdout: args.includes("--lint")
        ? `${JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })}\n`
        : "",
      stderr: "",
    }));
  });

  it.each([undefined, 5_000])("propagates the primary Doctor timeout %s", async (timeoutMs) => {
    await runUpdateFinalizationDoctorInFreshProcess({
      ...updateOptions,
      phase: "pre-plugin",
      timeoutMs,
    });
    expect(mocks.runExec).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/node",
      expect.arrayContaining(["doctor", "--repair"]),
      expect.objectContaining({ timeoutMs }),
    );
  });

  it.each([undefined, 5_000])(
    "bounds post-plugin checks separately from Doctor (%s)",
    async (timeoutMs) => {
      await completePostCorePluginUpdate({
        ...updateOptions,
        timeoutMs,
      });

      expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
        [
          "/opt/openclaw/dist/index.js",
          "doctor",
          "--repair",
          "--non-interactive",
          "--no-workspace-suggestions",
          "--yes",
        ],
        ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
        ["/opt/openclaw/dist/index.js", "doctor", "--lint", "--json", "--severity-min", "error"],
      ]);
      expect(mocks.runExec.mock.calls[2]?.[2]).toMatchObject({
        env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
      });
      expect(mocks.runExec.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
        timeoutMs,
        timeoutMs ?? 180_000,
        timeoutMs ?? 180_000,
      ]);
    },
  );

  it("runs updated readiness checks even when no plugin package changed", async () => {
    const beforeDoctor = vi.fn(async () => undefined);
    await completePostCorePluginUpdate({
      ...updateOptions,
      pluginUpdate: { ...pluginUpdate, changed: false },
      freshDoctorRequired: false,
      beforeDoctor,
    });

    expect(beforeDoctor).not.toHaveBeenCalled();
    expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
      ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
      ["/opt/openclaw/dist/index.js", "doctor", "--lint", "--json", "--severity-min", "error"],
    ]);
  });

  it("runs recorded deferred retirement when the published driver flag is false", async () => {
    await withTempHome(async () => {
      const run = createUpdateRun({ trigger: "cli" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
        detail: "Model retirement repair deferred until plugin convergence.",
      });
      const beforeDoctor = vi.fn(async () => undefined);

      await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
        freshDoctorRequired: false,
        beforeDoctor,
      });

      expect(beforeDoctor).toHaveBeenCalledOnce();
      expect(mocks.runExec.mock.calls[0]?.[1]).toEqual([
        "/opt/openclaw/dist/index.js",
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
        "--yes",
      ]);
      expect(mocks.runExec.mock.calls[0]?.[2]).toMatchObject({
        env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
      });
    });
  });

  it.each([false, true])(
    "preserves an unconfigured install through finalization (Doctor: %s)",
    async (freshDoctorRequired) => {
      await withTempHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const io = createConfigIO({ configPath, observe: false });
        mocks.readConfig.mockImplementation(() => io.readConfigFileSnapshot());
        const runNormally = mocks.runExec.getMockImplementation()!;
        mocks.runExec.mockImplementation(async (command, args: string[], options) => {
          if (args.includes("validate")) {
            throw new Error("Config file not found");
          }
          return await runNormally(command, args, options);
        });

        const result = await completePostCorePluginUpdate({
          ...updateOptions,
          freshDoctorRequired,
        });

        expect(result.pluginUpdate.status).toBe("ok");
        expect(result.configSnapshot).toMatchObject({ exists: false, valid: true });
        expect(mocks.runExec.mock.calls.some(([, args]) => args.includes("--lint"))).toBe(true);
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("validates a config created during fresh Doctor before allowing restart", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({ configPath, observe: false });
      mocks.readConfig.mockImplementation(() => io.readConfigFileSnapshot());
      mocks.runExec.mockImplementation(async (_command, args: string[]) => {
        if (args.includes("--repair")) {
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, '{"gateway":{"mode":"invalid"}}');
        }
        if (args.includes("validate")) {
          throw new Error("Config invalid");
        }
        return { stdout: "", stderr: "" };
      });

      const result = await completePostCorePluginUpdate(updateOptions);

      expect(result.configSnapshot).toMatchObject({ exists: true, valid: false });
      expect(result.pluginUpdate).toMatchObject({
        status: "error",
        reason: "post-plugin-doctor-invalid-config",
      });
    });
  });

  it("consumes nonfatal Doctor warnings before reporting successful convergence", async () => {
    const warnings = ["Optional probe timed out; recheck after restart."];
    const onWarnings = vi.fn();
    let resultPath = "";
    const runNormally = mocks.runExec.getMockImplementation()!;
    mocks.runExec.mockImplementation(async (command, args: string[], options) => {
      if (args.includes("--repair")) {
        resultPath = options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: { status: "ok", warnings },
        });
      }
      return await runNormally(command, args, options);
    });

    const result = await completePostCorePluginUpdate({ ...updateOptions, onWarnings });

    expect(result.pluginUpdate.status).toBe("ok");
    expect(onWarnings).toHaveBeenCalledExactlyOnceWith(warnings);
    expect(await consumeUpdatePostInstallDoctorResult(resultPath)).toBeNull();
  });

  it.each([false, true])(
    "preserves deferred repair advisory semantics (timed out: %s)",
    async (timedOut) => {
      mocks.runExec.mockImplementation(async (_command, _args, options) => {
        await writeUpdatePostInstallDoctorResult({
          resultPath: options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
          result: createDeferredConfiguredPluginRepairDoctorResult(["plugin repair deferred"]),
        });
        throw Object.assign(new Error("Doctor advisory"), {
          failed: true,
          exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
          timedOut,
        });
      });
      const run = runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase: "pre-plugin",
      });
      if (timedOut) {
        await expect(run).rejects.toThrow("Doctor advisory");
      } else {
        await expect(run).resolves.toBeUndefined();
      }
    },
  );

  it("carries the Doctor's failing check through fresh-process convergence", async () => {
    const failureFacts = [
      {
        check: "state.session-participants",
        code: "step-refused",
        message: "Required session migration could not acquire its writer.",
      },
    ];
    const runNormally = mocks.runExec.getMockImplementation()!;
    mocks.runExec.mockImplementation(async (command, args: string[], options) => {
      if (!args.includes("--repair")) {
        return await runNormally(command, args, options);
      }
      await writeUpdatePostInstallDoctorResult({
        resultPath: options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
        result: { status: "error", failureFacts },
      });
      throw Object.assign(new Error("Doctor exited"), {
        exitCode: 1,
        stderr: "Last cleanup message",
      });
    });
    await expect(
      runUpdateFinalizationDoctorInFreshProcess({
        ...updateOptions,
        phase: "pre-plugin",
      }),
    ).rejects.toMatchObject({ failureFacts });
    const result = await completePostCorePluginUpdate(updateOptions);
    expect(result.pluginUpdate).toMatchObject({ status: "error", failureFacts });
  });

  it("requires the lifecycle owner before starting fresh Doctor maintenance", async () => {
    const beforeDoctor = vi.fn(async () => undefined);
    await completePostCorePluginUpdate({
      ...updateOptions,
      beforeDoctor,
    });
    expect(beforeDoctor).toHaveBeenCalledOnce();
    expect(beforeDoctor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runExec.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("uses target validation when the unchanged-plugin parent retains an older schema", async () => {
    mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, valid: false });
    const result = await completePostCorePluginUpdate({
      ...updateOptions,
      pluginUpdate: { ...pluginUpdate, changed: false },
      freshDoctorRequired: false,
    });
    expect(result.pluginUpdate.status).toBe("ok");
    expect(result.configSnapshot.valid).toBe(false);
    expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
      ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
      ["/opt/openclaw/dist/index.js", "doctor", "--lint", "--json", "--severity-min", "error"],
    ]);
  });

  it("preserves the older target database when reading post-update config context", async () => {
    const stateDir = tempDirs.make("openclaw-post-update-target-schema-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    const filename = openOpenClawStateDatabase({ env: process.env }).path;
    closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(filename);
    try {
      removePreparedWorkerOwnershipColumns(db);
      db.exec(
        "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
      );
      const beforeSchema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      const beforeMeta = db.prepare("SELECT * FROM schema_meta").all();
      const configOwner =
        await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
      mocks.readConfig.mockImplementation(configOwner.readConfigFileSnapshot);

      const result = await completePostCorePluginUpdate({
        ...updateOptions,
        pluginUpdate: { ...pluginUpdate, changed: false },
        freshDoctorRequired: false,
      });

      expect(result.pluginUpdate.status).toBe("ok");
      expect(result.configSnapshot.config.gateway?.mode).toBe("local");
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
      expect(db.prepare("SELECT * FROM schema_meta").all()).toEqual(beforeMeta);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(beforeSchema);
    } finally {
      db.close();
    }
  });

  it("does not start Doctor when the lifecycle owner refuses maintenance", async () => {
    const beforeDoctor = vi.fn(async () => {
      throw new Error("Gateway owner changed");
    });
    const result = await completePostCorePluginUpdate({
      ...updateOptions,
      beforeDoctor,
    });
    expect(beforeDoctor).toHaveBeenCalledOnce();
    expect(mocks.runExec.mock.calls.some(([, args]) => args.includes("--repair"))).toBe(false);
    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      warnings: [
        expect.objectContaining({ reason: expect.stringContaining("Gateway owner changed") }),
      ],
    });
  });

  it.each([true, false])("preserves readiness failures (config exists: %s)", async (exists) => {
    mocks.readConfig.mockResolvedValue({ ...validConfigSnapshot, exists });
    mocks.runExec.mockImplementation(async (_command, args: string[]) => {
      if (args.includes("--lint")) {
        throw Object.assign(new Error("readiness failed"), {
          exitCode: 1,
          stdout: `${JSON.stringify({
            ok: false,
            checksRun: 1,
            checksSkipped: 0,
            findings: [
              {
                checkId: "memory-core/managed-local-embedding-setup",
                severity: "error",
                source: "memory-core",
                message: "Managed local embeddings are unavailable.",
                fixHint:
                  "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
              },
            ],
          })}\n`,
          stderr: "",
        });
      }
      return { stdout: "", stderr: "" };
    });

    const result = await completePostCorePluginUpdate({
      ...updateOptions,
    });

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-failed",
      warnings: [
        {
          pluginId: "memory-core",
          reason: "memory-core/managed-local-embedding-setup",
          message: "Managed local embeddings are unavailable.",
          guidance: [
            "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
          ],
        },
      ],
    });
  });

  it("retains posture warnings while accepting post-plugin readiness", async () => {
    mocks.runExec.mockImplementation(async (_command, args: string[]) => ({
      stdout: args.includes("--lint")
        ? JSON.stringify({
            ok: true,
            checksRun: 1,
            findings: [],
            warnings: [
              {
                checkId: "core/doctor/security",
                severity: "warning",
                message: "Open group policy permits mention-gated requests.",
                fixHint: "Review the group allowlist.",
              },
            ],
          })
        : "",
      stderr: "",
    }));
    const result = await completePostCorePluginUpdate(updateOptions);
    expect(result.pluginUpdate).toMatchObject({
      status: "warning",
      warnings: [
        {
          reason: "doctor-advisory",
          message: "Open group policy permits mention-gated requests.",
          guidance: ["Review the group allowlist."],
        },
      ],
    });
  });

  it.each([
    {
      label: "malformed output",
      stdout: "{not-json\n",
    },
    {
      label: "no declared check",
      stdout: `${JSON.stringify({ ok: true, checksRun: 0, checksSkipped: 0, findings: [] })}\n`,
    },
  ])("fails closed on $label from the updated readiness child", async ({ stdout }) => {
    mocks.runExec.mockImplementation(async (_command, args: string[]) => ({
      stdout: args.includes("--lint") ? stdout : "",
      stderr: "",
    }));

    const result = await completePostCorePluginUpdate({
      ...updateOptions,
    });

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-execution-failed",
      warnings: [
        expect.objectContaining({
          message: "Updated plugin readiness checks could not be completed before restart.",
        }),
      ],
    });
  });
});
