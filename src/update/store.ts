import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir, resolveConfigPath } from "../config/paths.js";
import { syncDirectoryIfSupported } from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { servingGitReleaseSlot } from "../infra/git-release-paths.js";
import { collectPackageReleases } from "../infra/package-release-retention.js";
import { readPackageReleaseSlotSync } from "../infra/package-release-slot-path.js";
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

/** A published release or trial keeps the resident owner, including before first activation. */
export async function hasReleaseUpdateOwner(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const prefix = resolvePrefix(env);
  return Boolean(
    readPackageReleaseSlotSync(servingGitReleaseSlot(prefix)) || (await readTrial(prefix))?.v === 2,
  );
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

function ownerDead(lock: Pick<UpdateLock, "pid">): boolean {
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
  input: Pick<UpdateLock, "runId" | "deadlineMs">,
  prefix = resolvePrefix(),
): Promise<UpdateLockAcquisition> {
  return takeUpdateLock(input, prefix);
}

type UpdateLockAcquisition =
  | { acquired: true; lock: UpdateLock; release: () => Promise<void> }
  | { acquired: false; lock: UpdateLock };

async function takeUpdateLock(
  input: Pick<UpdateLock, "runId" | "deadlineMs">,
  prefix: string,
  expected?: UpdateLock,
): Promise<UpdateLockAcquisition> {
  const file = path.join(prefix, "releases", ".update.lock");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock: UpdateLock = { ...input, pid: process.pid, startedAt: Date.now() };
  const canReclaim = (payload: unknown) => {
    const incumbent = asNullableRecord(payload);
    return Boolean(
      incumbent &&
      typeof incumbent.pid === "number" &&
      (!expected ||
        (incumbent.runId === expected.runId &&
          incumbent.pid === expected.pid &&
          incumbent.startedAt === expected.startedAt &&
          incumbent.deadlineMs === expected.deadlineMs)) &&
      ownerDead({ pid: incumbent.pid }),
    );
  };
  try {
    // Budget expiry cannot evict a live preparer. The provider serializes dead-owner
    // reclamation and binds release to this acquisition, preserving any successor.
    const held = await acquireFileLock(file, {
      managerKey: "openclaw.update.prepare",
      lockPath: file,
      payload: () => lock,
      retry: { retries: 0 },
      staleRecovery: "remove-if-unchanged",
      shouldReclaim: ({ payload }) => canReclaim(payload),
      shouldRemoveStaleLock: ({ payload }) => canReclaim(payload),
      // Gateway readiness must still find an interrupted preparer's run after exit.
      retainOnExit: true,
    });
    return { acquired: true, lock, release: () => held.release() };
  } catch (error) {
    if (hasErrnoCode(error, "file_lock_timeout") || hasErrnoCode(error, "file_lock_stale")) {
      const incumbent = await readUpdateLock(prefix);
      if (incumbent) {
        return { acquired: false, lock: incumbent };
      }
    }
    throw error;
  }
}

/** A stale readiness observation may retire only that dead owner, never its successor. */
export async function retireDeadUpdateLock(expected: UpdateLock, prefix = resolvePrefix()) {
  const held = await takeUpdateLock({ runId: expected.runId, deadlineMs: 0 }, prefix, expected);
  if (held.acquired) {
    await held.release();
  }
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
