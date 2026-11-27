import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir, resolveConfigPath } from "../config/paths.js";
import { syncDirectoryIfSupported } from "../infra/directory-durability.js";
import { hasErrnoCode, ignoreMissingPath } from "../infra/errno.js";
import { servingGitReleaseSlot } from "../infra/git-release-paths.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  collectPackageReleases,
  PACKAGE_RELEASE_MIN_AGE_MS,
} from "../infra/package-release-retention.js";
import { readPackageReleaseSlotSync } from "../infra/package-release-slot-path.js";
import {
  capturePackageReleaseSlot,
  switchPackageReleaseLink,
} from "../infra/package-release-slot.js";
import { isPidDefinitelyDeadAsync } from "../shared/pid-alive.js";

export type ReleaseKind = "git" | "package";
export type Trial = {
  v: 2;
  runId: string;
  phase: "pending" | "trial" | "restoring" | "committed" | "rolled-back";
  target: string;
  previous: string;
  buildId?: string;
  version: string;
  createdAt: number;
  attempts: number;
  config?: string;
  acceptCapabilities?: boolean;
  restoring?: Array<{ suffix: string; files: string[] }>;
  outcome?: {
    status: "succeeded" | "rolled-back";
    buildId?: string;
    reason?: string;
    stderrTail?: string;
    at: number;
  };
  reported?: boolean;
};
export type Staging = { id: string; kind: ReleaseKind; path: string; releaseRoot: string };
export type UpdateLock = { runId: string; pid: number; startedAt: number; deadlineMs: number };

export function resolvePrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "git-install");
}

/** A published release or trial keeps the resident owner, including before first activation. */
export async function hasReleaseUpdateOwner(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const prefix = resolvePrefix(env);
  return Boolean(
    readPackageReleaseSlotSync(servingGitReleaseSlot(prefix)) || (await readTrial(prefix))?.v === 2,
  );
}

export async function allocateStaging(
  { kind = "git", id = randomUUID() }: { kind?: ReleaseKind; id?: string } = {},
  prefix = resolvePrefix(),
): Promise<Staging> {
  if (!/^[A-Za-z0-9][\w-]*$/u.test(id)) {
    throw new Error("Invalid release ID");
  }
  const staging = path.join(prefix, "releases", `.staging-${process.pid}-${id}`);
  await fs.mkdir(path.dirname(staging), { recursive: true });
  await fs.mkdir(staging);
  return { id, kind, path: staging, releaseRoot: path.join(staging, "openclaw") };
}

export async function publishStaging(staging: Staging): Promise<string> {
  const destination = path.join(path.dirname(staging.path), staging.id);
  const releaseRoot = path.join(destination, path.relative(staging.path, staging.releaseRoot));
  await fs.rename(staging.path, destination);
  // Keep the owner pointed at its disposable tree even if directory sync fails after rename.
  staging.path = destination;
  staging.releaseRoot = releaseRoot;
  await syncDirectoryIfSupported(path.dirname(destination));
  return releaseRoot;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    // SAFETY: these files are written only by this module's own writers for the same type.
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await syncDirectoryIfSupported(path.dirname(file));
}

export function readTrial(prefix = resolvePrefix()): Promise<Trial | null> {
  return readJson<Trial>(path.join(prefix, "releases", ".trial"));
}

export function writeTrial(trial: Trial, prefix = resolvePrefix()): Promise<void> {
  return atomicJson(path.join(prefix, "releases", ".trial"), trial);
}

export async function createTrialPending(
  input: Pick<
    Trial,
    "runId" | "target" | "previous" | "version" | "buildId" | "acceptCapabilities"
  >,
  prefix = resolvePrefix(),
): Promise<Trial> {
  const previous = await readTrial(prefix);
  if (previous && ["pending", "trial", "restoring"].includes(previous.phase)) {
    throw new Error(`An update trial is already ${previous.phase} (${previous.runId}).`);
  }
  const trial: Trial = {
    ...input,
    v: 2,
    phase: "pending",
    createdAt: 0,
    attempts: 0,
    config: resolveConfigPath(process.env),
  };
  await writeTrial(trial, prefix);
  return trial;
}

function ownerDead(lock: UpdateLock): boolean {
  if (Date.now() >= lock.startedAt + lock.deadlineMs) {
    return true;
  }
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return hasErrnoCode(error, "ESRCH");
  }
}

export async function readUpdateLock(
  prefix = resolvePrefix(),
): Promise<(UpdateLock & { dead: boolean }) | null> {
  const lock = await readJson<UpdateLock>(path.join(prefix, "releases", ".update.lock"));
  return lock ? { ...lock, dead: ownerDead(lock) } : null;
}

export async function acquireUpdateLock(
  input: Pick<UpdateLock, "runId" | "pid" | "deadlineMs">,
  prefix = resolvePrefix(),
): Promise<
  | { acquired: true; lock: UpdateLock; previous?: UpdateLock }
  | { acquired: false; lock: UpdateLock }
> {
  const file = path.join(prefix, "releases", ".update.lock");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock: UpdateLock = { ...input, startedAt: Date.now() };
  // Publish fully written bytes with an exclusive hard link: contenders never read an empty lock.
  const temporary = `${file}.${process.pid}-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(lock));
    await handle.sync();
  } finally {
    await handle.close();
  }
  let previous: UpdateLock | undefined;
  try {
    for (;;) {
      try {
        await fs.link(temporary, file);
        return { acquired: true, lock, ...(previous ? { previous } : {}) };
      } catch (error) {
        if (!hasErrnoCode(error, "EEXIST")) {
          throw error;
        }
        const incumbent = await readUpdateLock(prefix);
        if (!incumbent) {
          continue;
        }
        if (!incumbent.dead) {
          return { acquired: false, lock: incumbent };
        }
        previous = incumbent;
        await fs.rm(file, { force: true });
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function releaseUpdateLock(prefix = resolvePrefix()): Promise<void> {
  await fs.rm(path.join(prefix, "releases", ".update.lock"), { force: true });
}

export async function switchLink(target: string, prefix = resolvePrefix()): Promise<void> {
  const slot = path.join(prefix, "openclaw");
  const current = await fs.lstat(slot).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  });
  if (!current) {
    const temporary = path.join(prefix, `.openclaw.release-link-${process.pid}-${randomUUID()}`);
    await fs.symlink(path.resolve(prefix, target), temporary, "junction");
    await fs.rename(temporary, slot);
    await syncDirectoryIfSupported(prefix);
    return;
  }
  const capture = await capturePackageReleaseSlot(slot);
  if (capture.kind !== "link") {
    throw new Error(`${slot} is not a release link.`);
  }
  await switchPackageReleaseLink({
    slot,
    target: process.platform === "win32" ? path.resolve(prefix, target) : target,
    expected: capture,
    assertCurrent: () => {},
  });
}

/** Called under the preparation lock, before allocation. A settled trial bounds the startup
 * grace to the most recently deselected release instead of every build made in the past day. */
export async function collectReleases(
  prefix: string,
  runningRoot: string,
  env = process.env,
  previousLock?: UpdateLock,
) {
  const trial = await readTrial(prefix);
  const actualPrefix = await fs.realpath(prefix);
  const updater = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  // A Gateway that could not write its release lease still owns its loaded code. Do not
  // shorten the old grace on the strength of a selected link alone.
  const gateway =
    trial?.v === 2
      ? await (
          await import("./installation-identity.js")
        ).readUpdateGatewayRoot(env, updater ?? runningRoot)
      : undefined;
  if (gateway && !gateway.root) {
    return {
      removed: [],
      warnings: [
        "Release collection skipped; the live Gateway's installation could not be identified.",
      ],
    };
  }
  const expiredTrial =
    trial?.v === 2 &&
    trial.reported &&
    ["committed", "rolled-back"].includes(trial.phase) &&
    trial.outcome &&
    Date.now() - trial.outcome.at >= PACKAGE_RELEASE_MIN_AGE_MS;
  // First conversion may have rolled back to the external checkout rather than a release slot.
  // Verify that the launcher really switched back before admitting the failed target alone.
  const selectedRoot = await fs
    .realpath(path.join(actualPrefix, "openclaw"))
    .catch(ignoreMissingPath);
  const legacyRoot = await fs
    .realpath(path.join(actualPrefix, "lib", "node_modules", "openclaw"))
    .catch(ignoreMissingPath);
  const rolledBack =
    trial?.v === 2 &&
    trial.phase === "rolled-back" &&
    trial.reported &&
    selectedRoot &&
    selectedRoot === (await fs.realpath(path.resolve(actualPrefix, trial.previous)))
      ? { root: path.resolve(actualPrefix, trial.target), runId: trial.runId }
      : undefined;
  // A dead preparer can have renamed its exact run's tree before the first trial existed.
  const interrupted =
    previousLock && (await isPidDefinitelyDeadAsync(previousLock.pid))
      ? previousLock.runId
      : undefined;
  return collectPackageReleases({
    prefix: actualPrefix,
    slot: servingGitReleaseSlot(actualPrefix),
    keep: [
      runningRoot,
      ...(selectedRoot ? [selectedRoot] : []),
      ...(previousLock && !interrupted
        ? [path.join(actualPrefix, "releases", previousLock.runId)]
        : []),
      ...(updater ? [updater] : []),
      ...(legacyRoot ? [legacyRoot] : []),
      ...(gateway?.root ? [gateway.root] : []),
      ...(trial && !expiredTrial
        ? (rolledBack ? [trial.previous] : [trial.target, trial.previous]).map((target) =>
            path.resolve(actualPrefix, target),
          )
        : []),
    ],
    resident: { knownTrial: trial?.v === 2, rolledBack, interrupted },
    env,
  });
}
