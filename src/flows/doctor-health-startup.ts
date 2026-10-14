import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import { resolveDoctorRepairMode } from "../commands/doctor-repair-mode.js";
import { resolveIsNixMode, resolveStateDir } from "../config/paths.js";
import type { UpdatePostInstallDoctorResult } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { createNonExitingRuntime, defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { showDoctorHealthSummary } from "./doctor-health-contribution.js";

export const showDoctorIntro = (message: string) =>
  clackIntro(stylePromptTitle(message) ?? message);
export const showDoctorOutro = (message: string) =>
  clackOutro(stylePromptTitle(message) ?? message);

export function exitDoctorHealthFlow(runtime: RuntimeEnv, code: number): void {
  if (runtime === defaultRuntime) {
    exitCliAfterOutput(runtime, code);
  }
  runtime.exit(code);
}

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
  showIntro: (message: string) => void,
) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  const repairRuntime: RuntimeEnv = {
    ...effectiveRuntime,
    exit: createNonExitingRuntime().exit,
  };
  // Config loading can initialize SQLite-backed state before integrity runs.
  // Preserve the entry fact so doctor can report that automatic initialization.
  const stateDirExistedAtStart = stateDirectoryExistsAtDoctorStart();
  showIntro("OpenClaw doctor");
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
}): Promise<"handled" | "accepted" | { diagnosticExitCode: number }> {
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
  if (accepted) {
    return "accepted";
  }
  params.runtime.log("Doctor repairs skipped. Continuing read-only diagnosis.");
  // Suppressing repair prompts does not suppress migrations. Lint owns the
  // read-only state scope; return its outcome for settlement after outer custody.
  const { runDoctorLintCli } = await import("../commands/doctor-lint.js");
  return {
    diagnosticExitCode: await runDoctorLintCli(params.runtime, {
      allowExec: params.options.allowExec,
      deep: params.options.deep,
    }),
  };
}

export function showDoctorConfigWriteRefusal(
  ctx: DoctorHealthFlowContext,
): UpdatePostInstallDoctorResult | undefined {
  if (!ctx.configWriteRefusal) {
    return undefined;
  }
  showDoctorHealthSummary(ctx);
  showDoctorOutro(
    ctx.configResultWriteCommitted === true
      ? "Doctor finished, but some config fixes were not applied."
      : "Doctor finished, but config fixes were not applied.",
  );
  return {
    status: "error",
    failureFacts: [
      createUpdateFailureFact({
        check: "config-write",
        code: ctx.configWriteRefusal,
        message: "Doctor config fixes were not applied.",
      }),
    ],
  };
}

export async function runDoctorInstallationChecks(
  root: string | null,
  prompter: DoctorPrompter,
  runtime: RuntimeEnv,
) {
  const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
  const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
  const { noteBunCliLauncherIssues } = await import("../commands/doctor-bun-cli-launcher.js");
  const { noteStalePluginRuntimeSymlinks } =
    await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
  const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
  await maybeRepairUiProtocolFreshness(runtime, prompter);
  await noteSourceInstallIssues(root);
  await noteBunCliLauncherIssues({ root, prompter });
  await noteStalePluginRuntimeSymlinks(root);
  noteStartupOptimizationHints();
}

export async function prepareDoctorMaintenanceArchives(
  databasePreflight: DoctorDatabasePreflight | undefined,
  runtime: RuntimeEnv,
): Promise<DoctorDatabasePreflight["agentDatabaseMigrationDiscovery"]> {
  let discovery: DoctorDatabasePreflight["agentDatabaseMigrationDiscovery"];
  try {
    const { prepareDoctorDatabasePreflight } =
      await import("../commands/doctor-database-preflight.js");
    discovery = (databasePreflight ?? (await prepareDoctorDatabasePreflight()))
      .agentDatabaseMigrationDiscovery;
    if (discovery) {
      const { prepareCanonicalTranscriptArchiveMigrations } =
        await import("../infra/state-migrations.transcript-directives-archives.js");
      await prepareCanonicalTranscriptArchiveMigrations(discovery);
    }
  } catch (error) {
    // Offline admission still owns repairable schema and discovery failures.
    runtime.log(`Archive verification preparation deferred: ${String(error)}`);
  }
  const { waitForCliSignalExit } = await import("../cli/signal-exit-barrier.js");
  // Keep an accepted signal during preparation ahead of service custody.
  await waitForCliSignalExit();
  return discovery;
}

export async function prepareDoctorStateSchema(
  schemas: DoctorDatabasePreflight,
  shouldRepair: boolean,
) {
  if (!shouldRepair || !schemas.pendingMigrations?.some((entry) => entry.kind === "state")) {
    return undefined;
  }
  const { prepareLegacyStateDatabaseSchema } = await import("../infra/state-migrations.doctor.js");
  const { throwIfDoctorStateMigrationRefused } =
    await import("../infra/state-migrations.messages.js");
  const receipt = await prepareLegacyStateDatabaseSchema(process.env);
  throwIfDoctorStateMigrationRefused([receipt]);
  return receipt;
}
