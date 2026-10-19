import { beforeEach, describe, expect, it, vi } from "vitest";
import { appContainerSpawnCheck, nativeStatusCheck } from "./doctor-native-status-check.js";
import type { HealthCheckContext } from "./health-checks.js";

const { fsStatus, procStatus, guard } = vi.hoisted(() => ({
  fsStatus: vi.fn(),
  procStatus: vi.fn(),
  guard: vi.fn(),
}));
vi.mock("@openclaw/fs-safe", () => ({ getFsSafeNativeStatus: fsStatus }));
vi.mock("@openclaw/proc-safe", () => ({ getProcSafeNativeStatus: procStatus }));
vi.mock("../infra/windows-appcontainer-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/windows-appcontainer-spawn.js")>()),
  assertAppContainerSpawnSupported: guard,
}));
const context: HealthCheckContext = {
  mode: "doctor",
  cfg: {},
  runtime: { log() {}, error() {}, exit() {} },
};

beforeEach(() => {
  fsStatus.mockReset().mockResolvedValue({ mode: "auto", loaded: true, reason: "loaded" });
  procStatus.mockReset().mockReturnValue({ mode: "auto", loaded: true, reason: "loaded" });
  guard.mockReset();
});

describe("Doctor native helpers", () => {
  it("probes both helpers and reports loaded libraries as informational", async () => {
    expect(await nativeStatusCheck.detect(context)).toEqual([
      { checkId: "core/doctor/native-status", severity: "info", message: "fs-safe: loaded" },
      { checkId: "core/doctor/native-status", severity: "info", message: "proc-safe: loaded" },
    ]);
    expect(fsStatus).toHaveBeenCalledWith({ probe: true });
    expect(procStatus).toHaveBeenCalledWith({ probe: true });
  });
  it.each(["package-missing", "load-failed", "unsupported-target"])(
    "reports %s with the library guidance",
    async (reason) => {
      procStatus.mockReturnValue({
        mode: "auto",
        loaded: false,
        reason,
        guidance: "Reinstall the process helper.",
      });
      expect(await nativeStatusCheck.detect(context)).toContainEqual({
        checkId: "core/doctor/native-status",
        severity: "warning",
        message: `proc-safe: ${reason}`,
        fixHint: "Reinstall the process helper.",
      });
    },
  );
  it("does not warn when native loading was explicitly disabled", async () => {
    fsStatus.mockResolvedValue({
      mode: "off",
      loaded: false,
      reason: "disabled",
      guidance: "Native mode is off.",
    });
    expect(await nativeStatusCheck.detect(context)).toContainEqual({
      checkId: "core/doctor/native-status",
      severity: "info",
      message: "fs-safe: disabled",
      fixHint: "Native mode is off.",
    });
  });
  it("reports the named AppContainer failure and its remedy", async () => {
    const { AppContainerSpawnUnsupportedError } =
      await import("../infra/windows-appcontainer-spawn.js");
    guard.mockImplementation(() => {
      throw new AppContainerSpawnUnsupportedError("1.52.1");
    });
    expect(await appContainerSpawnCheck.detect(context)).toEqual([
      {
        checkId: "core/doctor/appcontainer-spawn",
        severity: "error",
        errorCode: "APPCONTAINER_SPAWN_UNSUPPORTED",
        message: expect.stringContaining(
          "AppContainer: libuv 1.52.1 cannot create child pipes; 1.53.0+ required",
        ),
      },
    ]);
  });
  it("has no AppContainer finding on compatible runtimes", async () => {
    expect(await appContainerSpawnCheck.detect(context)).toEqual([]);
  });
});
