import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as bundledHealthChecks from "../flows/bundled-health-checks.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import type { HealthCheckContext } from "../flows/health-checks.js";
import { parseReleasedDoctorLintReport } from "../infra/test-fixtures/update-doctor-lint.v2026-9-5.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ readConfigFileSnapshot: vi.fn() }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: await mocks.readConfigFileSnapshot({ observe: false }),
  }),
}));

const runtime = createTestRuntime();

describe("runDoctorLintCli config snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockReset();
    clearHealthChecksForTest();
  });

  it("shares one captured config across registration and checks without freezing the source", async () => {
    const config = { agents: { entries: { main: { name: "original" } } } };
    mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    const detect = vi.fn(async (ctx: HealthCheckContext) => {
      expect(captureRuntimeConfig(ctx.cfg)).toBe(ctx.cfg);
      return [];
    });
    registerHealthCheck({
      id: "test/captured-config",
      kind: "plugin",
      description: "Checks the read-only config capture",
      detect,
    });
    const registration = vi.spyOn(bundledHealthChecks, "registerBundledHealthChecks");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(
        await runDoctorLintCli(runtime, { json: true, onlyIds: ["test/captured-config"] }),
      ).toBe(0);
      expect(detect).toHaveBeenCalledOnce();
      const captured = detect.mock.calls[0]?.[0].cfg;
      expect(captured).toEqual(config);
      expect(captured).not.toBe(config);
      expect(registration.mock.calls[0]?.[0].cfg).toBe(captured);
      config.agents.entries.main.name = "changed";
      expect(captured?.agents?.entries?.main?.name).toBe("original");
    } finally {
      registration.mockRestore();
      stdout.mockRestore();
    }
  });

  it("bases exit code on the selected severity threshold", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot({}));

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "error",
        onlyIds: ["core/doctor/final-config-validation"],
      });

      expect(exitCode).toBe(0);
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload.schemaVersion).toBe(1);
      expect(payload.findings).toEqual([]);
      expect(parseReleasedDoctorLintReport(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        checksRun: 1,
        findings: [],
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it.each([1, 480])(
    "validates one shared config for %s agents and retains warnings",
    async (count) => {
      const snapshot = createTestConfigSnapshot({
        agents: {
          entries: Object.fromEntries(
            Array.from({ length: count }, (_, index) => [`agent-${index}`, {}]),
          ),
        },
      });
      snapshot.warnings.push({
        path: "plugins.load.paths",
        code: "configured-plugin-path-inspection-failed",
        source: "/fixture/plugin",
        errorCode: "EACCES",
        message: "Configured plugin path could not be inspected.",
        fixHint: "Restore access to /fixture/plugin, then run `openclaw doctor --fix`.",
      });
      mocks.readConfigFileSnapshot.mockResolvedValue(snapshot);

      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(
          await runDoctorLintCli(runtime, {
            json: true,
            onlyIds: ["core/doctor/final-config-validation"],
          }),
        ).toBe(1);
        expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
          ok: false,
          checksRun: 1,
          findings: [
            {
              checkId: "core/doctor/final-config-validation",
              severity: "warning",
              path: "plugins.load.paths",
              requirement: "configured-plugin-path-inspection-failed",
              source: "/fixture/plugin",
              errorCode: "EACCES",
              message: "Configured plugin path could not be inspected.",
              fixHint: "Restore access to /fixture/plugin, then run `openclaw doctor --fix`.",
            },
          ],
        });
        expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
      } finally {
        stdout.mockRestore();
      }
    },
  );

  it("emits structured JSON for invalid config snapshots", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.mode", message: "Required" }],
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, { json: true });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "core/doctor/final-config-validation",
            severity: "error",
            message: "Required",
            path: "gateway.mode",
          },
        ],
      });
      expect(runtime.error).not.toHaveBeenCalled();
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    } finally {
      stdout.mockRestore();
    }
  });
});
