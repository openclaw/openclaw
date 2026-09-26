import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveNewStateDir, resolveStateDir } from "../config/state-dir.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { inspectOtherOpenClawProcesses } from "../infra/openclaw-process-census.js";
import {
  inspectLegacyPluginSourceCaptureRoots,
  pruneLegacyPluginSourceCaptures,
  pruneUnreferencedPluginNativeCaptures,
} from "../plugins/plugin-source-capture-report.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { formatBytes } from "./doctor-disk-space.js";

export async function noteLegacyPluginSourceCaptures(
  env: NodeJS.ProcessEnv,
  shouldRepair = false,
): Promise<void> {
  const temporaryDirectories = [env.TMPDIR, env.TMP, env.TEMP].filter(
    (directory): directory is string => Boolean(directory?.trim()),
  );
  temporaryDirectories.push(
    path.join(
      resolveNewStateDir(() => resolveRequiredHomeDir(env)),
      "tmp",
    ),
  );
  const warnings: string[] = [];
  try {
    const { resolveGatewayService } = await import("../daemon/service.js");
    const command = await resolveGatewayService().readCommand(env, {
      requireLoaded: true,
      timeoutMs: 5_000,
    });
    for (const definition of [command, command?.managedDefinition]) {
      const directory = definition?.environment?.TMPDIR;
      if (directory?.trim()) {
        if (path.isAbsolute(directory)) {
          temporaryDirectories.push(directory);
        } else if (definition?.workingDirectory) {
          temporaryDirectories.push(path.resolve(definition.workingDirectory, directory));
        } else {
          warnings.push(
            "The managed service records a relative TMPDIR without a working directory; its legacy captures could not be inspected.",
          );
        }
      }
    }
  } catch (error) {
    warnings.push(`Could not inspect the managed service temporary directory: ${String(error)}`);
  }
  const report = await inspectLegacyPluginSourceCaptureRoots(
    resolveStateDir(env),
    temporaryDirectories,
  );
  warnings.push(...report.warnings);
  const lines: string[] = [];
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const assertCurrent = () => {
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error("Doctor does not hold Gateway maintenance; captures were preserved.");
    }
    maintenance.assertAdmission();
    const census = inspectOtherOpenClawProcesses();
    if ("error" in census) {
      throw new Error(census.error);
    }
    if (census.pids.length > 0) {
      throw new Error(
        `Other OpenClaw processes are still running (PIDs: ${census.pids.join(", ")}).`,
      );
    }
    maintenance.assertAdmission();
  };
  if (report.roots.length > 0) {
    lines.push(
      `${report.roots.length} legacy plugin capture root(s), ${formatBytes(report.totalBytes)} in known regular files.`,
      ...report.roots.map((root) => `- ${quoteCliArg(root.path)} (${formatBytes(root.bytes)})`),
      "They will be reclaimed at the next maintenance.",
    );
    if (shouldRepair) {
      const result = await pruneLegacyPluginSourceCaptures(report, assertCurrent);
      if (result.removed.length > 0) {
        lines.push(
          `Removed ${result.removed.length} legacy plugin capture root(s), ${formatBytes(result.removed.reduce((bytes, root) => bytes + root.bytes, 0))}.`,
          ...result.removed.map(
            (root) => `Removed ${quoteCliArg(root.path)} (${formatBytes(root.bytes)}).`,
          ),
        );
      }
      if (result.blockedReason) {
        lines.push(`Legacy capture cleanup skipped: ${result.blockedReason}`);
      }
      lines.push(
        ...result.skipped.map((root) => `Kept ${quoteCliArg(root.path)}: ${root.reason}.`),
      );
      warnings.push(...result.warnings);
    }
  }
  if (shouldRepair) {
    const native = await pruneUnreferencedPluginNativeCaptures(
      resolveStateDir(env),
      assertCurrent,
      env,
    );
    if (native.removed.length > 0) {
      lines.push(`Removed ${native.removed.length} unreferenced native plugin capture root(s).`);
    }
    warnings.push(...native.warnings);
  }
  if (warnings.length > 0) {
    lines.push(
      "Legacy capture inspection or cleanup was incomplete; sizes may be partial.",
      ...warnings,
    );
  }
  if (lines.length > 0) {
    note(lines.join("\n"), "Legacy plugin captures");
  }
}
