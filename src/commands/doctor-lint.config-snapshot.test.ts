// Prepare the real check graph before test-scoped deadlines and stdout captures begin.
import "../flows/doctor-core-checks.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import * as bundledHealthChecks from "../flows/bundled-health-checks.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import type { HealthCheckContext } from "../flows/health-checks.js";
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
let stdout: MockInstance<typeof process.stdout.write>;

describe("runDoctorLintCli config snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockReset();
    clearHealthChecksForTest();
    stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

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
    expect(await runDoctorLintCli(runtime, { json: true, onlyIds: ["test/captured-config"] })).toBe(
      0,
    );
    expect(detect).toHaveBeenCalledOnce();
    const captured = detect.mock.calls[0]?.[0].cfg;
    expect(captured).toEqual(config);
    expect(captured).not.toBe(config);
    expect(registration.mock.calls[0]?.[0].cfg).toBe(captured);
    config.agents.entries.main.name = "changed";
    expect(captured?.agents?.entries?.main?.name).toBe("original");
  });

  it("validates one shared config for 480 agents and retains warnings", async () => {
    const snapshot = createTestConfigSnapshot({
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: 480 }, (_, index) => [`agent-${index}`, {}]),
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

    expect(
      await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/final-config-validation"],
      }),
    ).toBe(1);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
      schemaVersion: 1,
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
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledExactlyOnceWith({ observe: false });
  });

  it("emits structured JSON for invalid config snapshots", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.mode", message: "Required" }],
    });

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
  });
});
