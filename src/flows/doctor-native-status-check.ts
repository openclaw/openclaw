import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/native-status";

export const nativeStatusCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  source: "doctor",
  description: "Native filesystem and process helpers are available for this runtime.",
  async detect() {
    const [
      { getFsSafeNativeStatus },
      { getProcSafeNativeStatus },
      { isSupported: isNativeChildReapingSupported },
    ] = await Promise.all([
      import("@openclaw/fs-safe"),
      import("@openclaw/proc-safe"),
      import("@openclaw/proc-safe/reaper"),
    ]);
    const statuses = await Promise.all([
      getFsSafeNativeStatus({ probe: true }),
      getProcSafeNativeStatus({ probe: true }),
    ]);
    const nativeChildReapingAvailable =
      process.platform !== "linux" || isNativeChildReapingSupported();
    return statuses.map((status, index): HealthFinding => {
      const library = index === 0 ? "fs-safe" : "proc-safe";
      const linuxProcessLoadFailure =
        library === "proc-safe" && process.platform === "linux" && status.reason === "load-failed";
      const nativeChildReapingUnavailable =
        library === "proc-safe" && process.platform === "linux" && !nativeChildReapingAvailable;
      let runtime = "";
      if (linuxProcessLoadFailure) {
        try {
          const report = process.report.getReport();
          const header = isRecord(report) ? report.header : undefined;
          if (isRecord(header) && typeof header.glibcVersionRuntime === "string") {
            runtime = ` (glibc ${header.glibcVersionRuntime})`;
          }
        } catch {
          // Runtime diagnostics must not prevent Doctor from reporting the remedy.
        }
      }
      const baseMessage = `${library}: ${status.reason}${runtime}`;
      const remedy = linuxProcessLoadFailure
        ? `${status.guidance ? `${status.guidance} ` : ""}Linux update ancestry can use /proc/<pid>/stat without the native helper. If ancestry remains unavailable, restore readable /proc or install a compatible process helper; after the recorded update driver exits, run \`openclaw update repair\`.`
        : status.guidance;
      return {
        checkId: CHECK_ID,
        severity: status.loaded || status.mode === "off" ? "info" : "warning",
        message: nativeChildReapingUnavailable
          ? `${baseMessage}; native child reaping is unavailable; supervised service-child commands may fail before launch`
          : baseMessage,
        fixHint: nativeChildReapingUnavailable
          ? `${remedy ?? ""}${remedy ? " " : ""}Restore a compatible native process helper and rerun \`openclaw doctor\` before retrying service-child commands.`
          : remedy,
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
