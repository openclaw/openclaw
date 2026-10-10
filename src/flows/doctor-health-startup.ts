import fs from "node:fs";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { resolveDoctorRepairMode } from "../commands/doctor-repair-mode.js";
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
  // Shipped updaters expose a restricted config-read bridge which cannot perform
  // this advisory source read. Defer it to ordinary Doctor after update settlement.
  if (!resolveDoctorRepairMode(options).updateInProgress) {
    // Source-only config reads avoid database admission and plugin validation: show
    // configured startup dependencies before offline maintenance and repair prompts.
    const [{ readSourceConfigBestEffort }, { inspectDoctorTailscalePrerequisite }] =
      await Promise.all([
        import("../config/io.runtime.js"),
        import("../commands/doctor-tailscale.js"),
      ]);
    const prerequisite = await inspectDoctorTailscalePrerequisite(
      await readSourceConfigBestEffort(),
    );
    if (prerequisite) {
      const { note } = await import("../../packages/terminal-core/src/note.js");
      note(prerequisite, "Gateway startup prerequisite");
    }
  }
  return { effectiveRuntime, repairRuntime, stateDirExistedAtStart, root };
}

export async function prepareDoctorInteractiveMaintenance(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  databasePreflight: DoctorDatabasePreflight | undefined;
  root: string | null;
  outro: (message: string) => void;
}): Promise<"handled" | "accepted" | "declined"> {
  const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
  const { prepareDoctorDatabasePreflight } =
    await import("../commands/doctor-database-preflight.js");
  const prompter = createDoctorPrompter({ runtime: params.runtime, options: params.options });
  // Preserve the installed Doctor's update escape hatch before taking service
  // custody. A newer state schema refuses before any prompt or native effect.
  if (!params.databasePreflight) {
    await prepareDoctorDatabasePreflight({ scope: "state" });
  }
  const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
  const offeredUpdate = await maybeOfferUpdateBeforeDoctor({
    options: params.options,
    root: params.root,
    confirm: (p) => prompter.confirm(p),
    outro: params.outro,
  });
  if (offeredUpdate.handled) {
    return "handled";
  }
  if (!params.databasePreflight) {
    // Refuse incompatible agent schemas before consent can pause the service.
    // Maintenance still rediscovers current facts after excluding publishers.
    await prepareDoctorDatabasePreflight();
  }
  const accepted = await prompter.confirmRuntimeRepair({
    message:
      "Pause the managed Gateway while you review repairs? Doctor restores its prior service state when finished.",
    initialValue: true,
    requiresInteractiveConfirmation: true,
  });
  if (!accepted) {
    params.outro("Doctor repairs cancelled. Run openclaw doctor --lint for read-only diagnosis.");
    return "declined";
  }
  return "accepted";
}
