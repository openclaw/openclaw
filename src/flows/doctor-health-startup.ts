import fs from "node:fs";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { resolveIsNixMode, resolveStateDir } from "../config/paths.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";

function stateDirectoryExistsAtDoctorStart(): boolean {
  try {
    return fs.statSync(resolveStateDir()).isDirectory();
  } catch {
    return false;
  }
}

export async function prepareDoctorHealthFlow(
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  intro: (message: string) => void,
) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  const repairRuntime: RuntimeEnv = {
    ...effectiveRuntime,
    exit: createNonExitingRuntime().exit,
  };
  // Config loading can initialize SQLite-backed state before integrity runs.
  // Preserve the entry fact so doctor can report that automatic initialization.
  const stateDirExistedAtStart = stateDirectoryExistsAtDoctorStart();
  intro("OpenClaw doctor");
  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (
    resolveIsNixMode() &&
    (options.repair === true || options.yes === true || options.generateGatewayToken === true)
  ) {
    const { assertConfigWriteAllowedInCurrentMode } =
      await import("../config/config-write-guard.js");
    assertConfigWriteAllowedInCurrentMode();
  }
  return { effectiveRuntime, repairRuntime, stateDirExistedAtStart, root };
}
