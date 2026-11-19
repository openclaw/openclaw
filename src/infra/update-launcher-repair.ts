import fs from "node:fs/promises";
import path from "node:path";
import { pathEntryExists } from "./path-existence.js";
import {
  relocateRuntimeLauncher,
  resolveRuntimeLauncherTargets,
} from "./update-runtime-relocation.js";

// `prepareNativePackageStage` creates `.<package>-update-native-XXXXXX` beside the live project.
const UPDATE_STAGE_DIRECTORY = /^\.[^/\\]+-update-native-[A-Za-z0-9]{6}$/u;
const CMD_SHIM_TARGET = /^# cmd-shim-target=(.+)$/mu;

export type StagedLauncherRepair =
  | { outcome: "current" | "not-ours" }
  | { outcome: "repaired"; file: string; stage: string; projectRoot: string };

function findStageDirectory(target: string): string | undefined {
  for (let current = target; ; current = path.dirname(current)) {
    if (UPDATE_STAGE_DIRECTORY.test(path.basename(current))) {
      return current;
    }
    if (path.dirname(current) === current) {
      return undefined;
    }
  }
}

/**
 * Repair a published pnpm launcher that still executes a removed update stage.
 * Earlier updaters published launchers from the stage without relocating pnpm 12.15+
 * quoted targets, so the CLI fails once activation moves the stage away. Only a launcher
 * that is provably this installation's is touched: its stage sits beside the live project
 * and its `cmd-shim-target` comment names the same entry inside that project.
 */
export async function repairStagedRuntimeLauncher(
  file: string,
  entryName = "openclaw.mjs",
): Promise<StagedLauncherRepair> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile()) {
    return { outcome: "not-ours" };
  }
  const content = await fs.readFile(file, "utf8");
  const targets = await resolveRuntimeLauncherTargets(file, entryName, content);
  const missing: string[] = [];
  for (const target of targets) {
    if (!(await pathEntryExists(target))) {
      missing.push(target);
    }
  }
  if (targets.length > 0 && missing.length === 0) {
    return { outcome: "current" };
  }
  const recorded = CMD_SHIM_TARGET.exec(content)?.[1]?.trim();
  const stage = missing.length ? findStageDirectory(missing[0]!) : undefined;
  if (!recorded || !stage || (await pathEntryExists(stage))) {
    return { outcome: "not-ours" };
  }
  const suffix = path.relative(stage, missing[0]!);
  if (!recorded.endsWith(`${path.sep}${suffix}`) || !(await pathEntryExists(recorded))) {
    return { outcome: "not-ours" };
  }
  const projectRoot = await fs.realpath(recorded.slice(0, -suffix.length - 1));
  if (path.dirname(projectRoot) !== (await fs.realpath(path.dirname(stage)))) {
    return { outcome: "not-ours" };
  }
  // Relocate a private copy, verify it, then replace the launcher in one rename.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.repair-${process.pid}`);
  await fs.copyFile(file, temporary);
  try {
    // pnpm 12 resolves the shim's directory physically; relocate from that same base.
    const physical = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
    await relocateRuntimeLauncher(temporary, physical, physical, [
      { sourceRoot: stage, destinationRoot: projectRoot },
    ]);
    const repaired = await resolveRuntimeLauncherTargets(
      file,
      entryName,
      await fs.readFile(temporary, "utf8"),
    );
    for (const target of repaired) {
      await fs.access(target);
    }
    if (repaired.length === 0) {
      throw new Error("The repaired launcher names no executable target");
    }
    await fs.chmod(temporary, stat.mode);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { outcome: "repaired", file, stage, projectRoot };
}

/**
 * Repair this installation's published pnpm launchers that still name a removed update
 * stage. Runs from the new package (Doctor and Gateway startup), so an update driven by
 * an older updater that left such a launcher heals without a user command.
 */
export async function repairPublishedPnpmLaunchers(params: {
  root: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Extract<StagedLauncherRepair, { outcome: "repaired" }>[]> {
  const root = await fs.realpath(params.root).catch(() => undefined);
  if (!root || process.platform === "win32") {
    return [];
  }
  const repaired: Extract<StagedLauncherRepair, { outcome: "repaired" }>[] = [];
  for (const file of new Set(listPnpmLauncherCandidates(params.root, params.env ?? process.env))) {
    const content = await fs.readFile(file, "utf8").catch(() => undefined);
    const recorded = content && CMD_SHIM_TARGET.exec(content)?.[1]?.trim();
    const recordedReal = recorded ? await fs.realpath(recorded).catch(() => undefined) : undefined;
    // Only launchers whose recorded target is this installation's entry.
    if (!recordedReal || recordedReal !== path.join(root, "openclaw.mjs")) {
      continue;
    }
    const repair = await repairStagedRuntimeLauncher(file);
    if (repair.outcome === "repaired") {
      repaired.push(repair);
    }
  }
  return repaired;
}

/** Published `openclaw` launchers a pnpm installation of `root` may own. */
export function listPnpmLauncherCandidates(root: string, env: NodeJS.ProcessEnv): string[] {
  const directories = new Set<string>();
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) {
    directories.add(path.join(pnpmHome, "bin"));
    directories.add(pnpmHome);
  }
  // pnpm keeps its global project and store under PNPM_HOME, beside the bin directory.
  const marker = /[/\\](?:global|store)[/\\]v\d+[/\\]/u.exec(root);
  if (marker) {
    const home = root.slice(0, marker.index);
    directories.add(path.join(home, "bin"));
    directories.add(home);
  }
  return [...directories].map((directory) => path.join(directory, "openclaw"));
}
