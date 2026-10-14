import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/native-status";

export const nativeStatusCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  source: "doctor",
  description: "Native filesystem and process helpers are available for this runtime.",
  async detect() {
    const [{ getFsSafeNativeStatus }, { getProcSafeNativeStatus }] = await Promise.all([
      import("@openclaw/fs-safe"),
      import("@openclaw/proc-safe"),
    ]);
    const statuses = await Promise.all([
      getFsSafeNativeStatus({ probe: true }),
      getProcSafeNativeStatus({ probe: true }),
    ]);
    return statuses.map((status, index): HealthFinding => {
      const library = index === 0 ? "fs-safe" : "proc-safe";
      return {
        checkId: CHECK_ID,
        severity: status.loaded || status.mode === "off" ? "info" : "warning",
        message: `${library}: ${status.reason}`,
        fixHint: status.guidance,
      };
    });
  },
};

export const appContainerSpawnCheck: HealthCheck = {
  id: "core/doctor/appcontainer-spawn",
  kind: "core",
  source: "doctor",
  description: "The Windows runtime can create child pipes inside an AppContainer.",
  async detect() {
    const { assertAppContainerSpawnSupported, AppContainerSpawnUnsupportedError } =
      await import("../infra/windows-appcontainer-spawn.js");
    try {
      assertAppContainerSpawnSupported();
      return [];
    } catch (error) {
      if (!(error instanceof AppContainerSpawnUnsupportedError)) {
        throw error;
      }
      return [
        {
          checkId: "core/doctor/appcontainer-spawn",
          severity: "error",
          errorCode: error.code,
          message: error.message,
        },
      ];
    }
  },
};
