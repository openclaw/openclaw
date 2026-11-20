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
 * that is provably this installation's is touched: its `cmd-shim-target` comment names
 * `root`'s entry, and its stage sits beside that live project. Ownership and relocation
 * use the same bytes, and the rename is skipped if the launcher changed meanwhile.
 */
async function repairStagedRuntimeLauncher(
  file: string,
  root: string,
  entryName = "openclaw.mjs",
): Promise<StagedLauncherRepair> {
  // pnpm writes regular files; reading a FIFO or device on PATH would block Doctor.
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile()) {
    return { outcome: "not-ours" };
  }
  const content = await fs.readFile(file, "utf8").catch(() => undefined);
  const recorded = content && CMD_SHIM_TARGET.exec(content)?.[1]?.trim();
  const recordedReal = recorded ? await fs.realpath(recorded).catch(() => undefined) : undefined;
  const ownEntry = path.join(await fs.realpath(root), entryName);
  if (!content || !recorded || recordedReal !== ownEntry) {
    return { outcome: "not-ours" };
  }
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
  const stage = missing.length ? findStageDirectory(missing[0]!) : undefined;
  if (!stage || (await pathEntryExists(stage))) {
    return { outcome: "not-ours" };
  }
  const suffix = path.relative(stage, missing[0]!);
  if (!recorded.endsWith(`${path.sep}${suffix}`)) {
    return { outcome: "not-ours" };
  }
  const projectRoot = await fs.realpath(recorded.slice(0, -suffix.length - 1));
  if (path.dirname(projectRoot) !== (await fs.realpath(path.dirname(stage)))) {
    return { outcome: "not-ours" };
  }
  // Relocate the analyzed content in a private directory beside the launcher, verify it,
  // then replace the launcher in one rename. The exclusive directory keeps another account
  // from planting a link where the repair writes.
  const staging = await fs.mkdtemp(path.join(path.dirname(file), ".openclaw-launcher-repair-"));
  const temporary = path.join(staging, path.basename(file));
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    // pnpm 12 resolves the shim's directory physically; relocate from that same base.
    const physical = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
    await relocateRuntimeLauncher(temporary, physical, physical, [
      { sourceRoot: stage, destinationRoot: projectRoot },
    ]);
    const relocated = await fs.readFile(temporary, "utf8");
    // A repair is complete only when nothing in the launcher (exec targets, NODE_PATH,
    // comments) still names the stage, in any spelling.
    if (relocated.includes(path.basename(stage))) {
      throw new Error("The repaired launcher still names the removed update stage");
    }
    const repaired = await resolveRuntimeLauncherTargets(file, entryName, relocated);
    for (const target of repaired) {
      await fs.access(target);
    }
    if (repaired.length === 0) {
      throw new Error("The repaired launcher names no executable target");
    }
    await fs.chmod(temporary, stat.mode & 0o7777);
    // A package manager may have replaced the shim since it was inspected; leave its write.
    if ((await fs.readFile(file, "utf8").catch(() => undefined)) !== content) {
      throw new Error("The launcher changed while it was being repaired; it was left as is");
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
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
}): Promise<{
  repaired: Extract<StagedLauncherRepair, { outcome: "repaired" }>[];
  failed: { file: string; error: unknown }[];
}> {
  const repaired: Extract<StagedLauncherRepair, { outcome: "repaired" }>[] = [];
  const failed: { file: string; error: unknown }[] = [];
  const root = await fs.realpath(params.root).catch(() => undefined);
  if (!root || process.platform === "win32") {
    return { repaired, failed };
  }
  for (const file of new Set(listPnpmLauncherCandidates(params.root, params.env ?? process.env))) {
    try {
      const repair = await repairStagedRuntimeLauncher(file, root);
      if (repair.outcome === "repaired") {
        repaired.push(repair);
      }
    } catch (error) {
      failed.push({ file, error });
    }
  }
  return { repaired, failed };
}

/**
 * Published `openclaw` launchers a pnpm installation of `root` may own: its pnpm home
 * and bin directory, and every PATH entry, since `pnpm bin -g` can be configured outside
 * PNPM_HOME. Callers still require the exact recorded target before any write.
 */
function listPnpmLauncherCandidates(root: string, env: NodeJS.ProcessEnv): string[] {
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
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (path.isAbsolute(directory)) {
      directories.add(directory);
    }
  }
  return [...directories].map((directory) => path.join(directory, "openclaw"));
}
