import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeUpdatePostInstallDoctorResult,
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
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
  valid: true as const,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

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

  it("returns the owner-provided remediation and refuses restart when readiness fails", async () => {
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
