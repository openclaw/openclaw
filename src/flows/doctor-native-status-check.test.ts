import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appContainerSpawnCheck, nativeStatusCheck } from "./doctor-native-status-check.js";
import type { HealthCheckContext } from "./health-checks.js";

const { fsStatus, procStatus, guard } = vi.hoisted(() => ({
  fsStatus: vi.fn(),
  procStatus: vi.fn(),
  guard: vi.fn(),
}));
vi.mock("@openclaw/fs-safe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe")>()),
  getFsSafeNativeStatus: fsStatus,
}));
vi.mock("@openclaw/proc-safe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe")>()),
  getProcSafeNativeStatus: procStatus,
}));
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
afterEach(() => vi.restoreAllMocks());

it("probes both helpers and reports loaded libraries as informational", async () => {
  expect(await nativeStatusCheck.detect(context)).toEqual([
    { checkId: "core/doctor/native-status", severity: "info", message: "fs-safe: loaded" },
    { checkId: "core/doctor/native-status", severity: "info", message: "proc-safe: loaded" },
  ]);
  expect(fsStatus).toHaveBeenCalledWith({ probe: true });
  expect(procStatus).toHaveBeenCalledWith({ probe: true });
});
it.each([
  ["proc-safe", "package-missing", "darwin"],
  ["proc-safe", "load-failed", "darwin"],
  ["proc-safe", "unsupported-target", "darwin"],
  ["fs-safe", "disabled", "darwin"],
  ["proc-safe", "load-failed", "linux"],
] as const)("reports %s %s on %s with actionable guidance", async (library, reason, platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.spyOn(process.report, "getReport").mockReturnValue({
    header: { glibcVersionRuntime: "2.28" },
  });
  const disabled = reason === "disabled";
  (library === "fs-safe" ? fsStatus : procStatus).mockReturnValue({
    mode: disabled ? "off" : "auto",
    loaded: false,
    reason,
    guidance: "Library guidance.",
  });
  const linuxFailure = platform === "linux";
  expect(await nativeStatusCheck.detect(context)).toContainEqual({
    checkId: "core/doctor/native-status",
    severity: disabled ? "info" : "warning",
    message: `${library}: ${reason}${linuxFailure ? " (glibc 2.28)" : ""}`,
    fixHint: linuxFailure
      ? expect.stringMatching(/^Library.*\/proc\/.*driver exits.*openclaw update repair/)
      : "Library guidance.",
  });
});
it("reports the named AppContainer failure and its remedy", async () => {
  expect(await appContainerSpawnCheck.detect(context)).toEqual([]);
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
