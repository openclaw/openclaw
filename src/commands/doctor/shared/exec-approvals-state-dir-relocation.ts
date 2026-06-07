// Doctor migration: relocate a legacy home-relative exec-approvals policy file into
// the resolved state dir. Exec approvals now read only resolveStateDir()/exec-approvals.json,
// but earlier versions always wrote ~/.openclaw/exec-approvals.json regardless of
// OPENCLAW_STATE_DIR. Without this migration a relocated-state install would silently
// fall back to the default full/off policy on upgrade, dropping an existing
// deny/allowlist policy. Runtime stays canonical-only; legacy resolution lives here.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveNewStateDir, resolveStateDir } from "../../../config/paths.js";
import {
  EXEC_APPROVALS_FILENAME,
  EXEC_APPROVALS_SOCKET_FILENAME,
  type ExecApprovalsFile,
} from "../../../infra/exec-approvals.js";
import { assertNoSymlinkParentsSync } from "../../../infra/fs-safe-advanced.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../../../infra/home-dir.js";
import { shortenHomePath } from "../../../utils.js";

const EXEC_APPROVALS_FILE_MODE = 0o600;

function resolveCanonicalPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), EXEC_APPROVALS_FILENAME);
}

function resolveCanonicalSocketPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), EXEC_APPROVALS_SOCKET_FILENAME);
}

// The legacy location is always <home>/.openclaw, matching the historical
// expandHomePrefix("~/.openclaw/...") that ignored OPENCLAW_STATE_DIR.
function resolveLegacyHomePath(env: NodeJS.ProcessEnv): string {
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  return path.join(resolveNewStateDir(homedir), EXEC_APPROVALS_FILENAME);
}

// The generated default socket the shipped runtime persisted alongside the legacy
// policy: always <home>/.openclaw/exec-approvals.sock, matching the historical
// resolveExecApprovalsSocketPath() that ignored OPENCLAW_STATE_DIR.
function resolveLegacyDefaultSocketPath(env: NodeJS.ProcessEnv): string {
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  return path.join(resolveNewStateDir(homedir), EXEC_APPROVALS_SOCKET_FILENAME);
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

// A relocated policy whose socket.path still points at the generated home default would
// keep command-approval IPC on the old socket after the file moves, so the policy file and
// approval socket disagree. Rewrite that one generated value to the canonical socket;
// operator-chosen custom socket paths are left untouched.
function rewriteLegacyDefaultSocketPath(params: { raw: string; env: NodeJS.ProcessEnv }): {
  raw: string;
  rewritten: boolean;
} {
  let parsed: ExecApprovalsFile;
  try {
    parsed = JSON.parse(params.raw) as ExecApprovalsFile;
  } catch {
    // Unparseable legacy content has no recognizable socket path; relocate it verbatim.
    return { raw: params.raw, rewritten: false };
  }
  const persisted = parsed?.socket?.path?.trim();
  if (!persisted) {
    return { raw: params.raw, rewritten: false };
  }
  const homedir = () => resolveRequiredHomeDir(params.env, os.homedir);
  const persistedAbs = path.resolve(expandHomePrefix(persisted, { env: params.env, homedir }));
  const legacyDefaultAbs = path.resolve(resolveLegacyDefaultSocketPath(params.env));
  if (persistedAbs !== legacyDefaultAbs) {
    return { raw: params.raw, rewritten: false };
  }
  const next: ExecApprovalsFile = {
    ...parsed,
    socket: { ...parsed.socket, path: resolveCanonicalSocketPath(params.env) },
  };
  return { raw: `${JSON.stringify(next, null, 2)}\n`, rewritten: true };
}

// Write the relocated policy via a temp file in the canonical dir then rename, so the
// move is atomic and stays on one device (the legacy file may live on another mount).
// O_EXCL refuses to follow or clobber anything already at the canonical path.
async function writeCanonicalPolicy(canonicalPath: string, raw: string): Promise<void> {
  const dir = path.dirname(canonicalPath);
  // Mirror the runtime exec-approvals write guard (ensureDir): refuse to relocate into a
  // symlinked state dir. Without this the policy would land somewhere runtime later refuses
  // to read while the legacy file is already removed, breaking exec approvals. Anchored at
  // the dir's parent like the runtime guard so the final state-dir component is checked too.
  assertNoSymlinkParentsSync({
    rootDir: path.dirname(dir),
    targetPath: dir,
    allowOutsideRoot: true,
    messagePrefix: "Refusing to relocate exec approvals into symlinked path",
  });
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.exec-approvals.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, raw, { mode: EXEC_APPROVALS_FILE_MODE, flag: "wx" });
    await fs.rename(tempPath, canonicalPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

/** Move a pre-existing home-relative exec-approvals policy file into the resolved state dir. */
export async function relocateLegacyExecApprovalsStateFile(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params?.env ?? process.env;
  const canonicalPath = path.resolve(resolveCanonicalPath(env));
  const legacyPath = path.resolve(resolveLegacyHomePath(env));
  const changes: string[] = [];
  const warnings: string[] = [];

  // Default installs already resolve to the legacy location, so there is nothing to move.
  if (canonicalPath === legacyPath) {
    return { changes, warnings };
  }
  if (!(await pathExists(legacyPath))) {
    return { changes, warnings };
  }
  if (!(await isRegularFile(legacyPath))) {
    warnings.push(
      `Legacy exec-approvals policy at ${shortenHomePath(legacyPath)} is not a regular file; ` +
        `move it to ${shortenHomePath(canonicalPath)} manually so the relocated state dir keeps your approval policy.`,
    );
    return { changes, warnings };
  }
  if (await pathExists(canonicalPath)) {
    // Both present: the runtime already uses the canonical file, so refuse to clobber it.
    // Surface the now-ignored legacy file instead of silently dropping or overwriting policy.
    warnings.push(
      `Both ${shortenHomePath(canonicalPath)} and the legacy ${shortenHomePath(legacyPath)} exec-approvals policies exist; ` +
        `the relocated state dir file is authoritative. Reconcile and remove the legacy file.`,
    );
    return { changes, warnings };
  }

  try {
    const legacyRaw = await fs.readFile(legacyPath, "utf8");
    const { raw, rewritten } = rewriteLegacyDefaultSocketPath({ raw: legacyRaw, env });
    await writeCanonicalPolicy(canonicalPath, raw);
    await fs.unlink(legacyPath);
    changes.push(
      rewritten
        ? `Moved exec-approvals policy from ${shortenHomePath(legacyPath)} to ${shortenHomePath(canonicalPath)} ` +
            `and rewrote the generated socket path to ${shortenHomePath(resolveCanonicalSocketPath(env))} ` +
            `so the relocated state dir keeps your approval policy and its IPC socket.`
        : `Moved exec-approvals policy from ${shortenHomePath(legacyPath)} to ${shortenHomePath(canonicalPath)} so the relocated state dir keeps your approval policy.`,
    );
  } catch (error) {
    warnings.push(
      `Failed to move exec-approvals policy from ${shortenHomePath(legacyPath)} to ${shortenHomePath(canonicalPath)}: ${String(error)}`,
    );
  }

  return { changes, warnings };
}
