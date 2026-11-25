import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir, resolveConfigPath } from "../config/paths.js";
import { syncDirectoryIfSupported } from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { collectPackageReleases } from "../infra/package-release-retention.js";
import {
  capturePackageReleaseSlot,
  switchPackageReleaseLink,
} from "../infra/package-release-slot.js";

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

function releaseRootOf(id: string, prefix = resolvePrefix()): string {
  return path.join(prefix, "releases", id, "openclaw");
}

export async function allocateStaging(
  { kind = "git", id = randomUUID() }: { kind?: ReleaseKind; id?: string } = {},
  prefix = resolvePrefix(),
): Promise<Staging> {
  const staging = path.join(prefix, "releases", `.staging-${id}`);
  await fs.mkdir(path.dirname(staging), { recursive: true });
  await fs.mkdir(staging);
  return { id, kind, path: staging, releaseRoot: releaseRootOf(`.staging-${id}`, prefix) };
}

export async function publishStaging(staging: Staging): Promise<string> {
  const destination = path.join(path.dirname(staging.path), staging.id);
  await fs.rename(staging.path, destination);
  await syncDirectoryIfSupported(path.dirname(destination));
  return path.join(destination, path.relative(staging.path, staging.releaseRoot));
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

export async function collectReleases(prefix = resolvePrefix()) {
  const trial = await readTrial(prefix);
  return collectPackageReleases({
    prefix,
    slot: path.join(prefix, "openclaw"),
    keep: trial ? [trial.target, trial.previous].map((target) => path.resolve(prefix, target)) : [],
  });
}
