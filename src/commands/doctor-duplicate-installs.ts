import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { note } from "../terminal/note.js";

const execFileAsync = promisify(execFile);

export type OpenClawInstallation = {
  binPath: string;
  version: string | null;
  isCurrent: boolean;
};

export type DuplicateInstallResult = {
  installations: OpenClawInstallation[];
  warnings: string[];
};

/**
 * Collect candidate directories that might contain an `openclaw` binary.
 * Always includes PATH entries plus well-known npm/node global dirs.
 */
export function collectCandidateDirs(env: Record<string, string | undefined>): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const dirs = new Set<string>();

  // PATH entries
  const pathVar = env.PATH ?? "";
  for (const entry of pathVar.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (trimmed) {
      dirs.add(trimmed);
    }
  }

  // Well-known global install locations
  const wellKnown = [
    "/usr/bin",
    "/usr/local/bin",
    "/usr/lib/node_modules/.bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".npm-global", "lib", "node_modules", ".bin"),
    // volta
    path.join(home, ".volta", "bin"),
    // nvm typical
    path.join(home, ".nvm", "current", "bin"),
    // fnm
    path.join(home, ".local", "share", "fnm", "current", "bin"),
    // pnpm global
    path.join(home, ".local", "share", "pnpm"),
    // Linuxbrew
    path.join(home, ".linuxbrew", "bin"),
    "/home/linuxbrew/.linuxbrew/bin",
  ];

  for (const dir of wellKnown) {
    dirs.add(dir);
  }

  return [...dirs];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveRealPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

async function probeVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binPath, ["--version"], {
      timeout: 5000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const trimmed = stdout.trim();
    // Version output is typically just the version string or "openclaw vX.Y.Z"
    const match = trimmed.match(/(\d{4}\.\d+\.\d+(?:[a-zA-Z0-9._-]*))/);
    return match?.[1] ?? trimmed.split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function findOpenClawInstallations(
  env: Record<string, string | undefined>,
): Promise<OpenClawInstallation[]> {
  const candidateDirs = collectCandidateDirs(env);
  const binName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const seen = new Set<string>();
  const installations: OpenClawInstallation[] = [];

  // Determine the "current" binary — what `process.argv[1]` resolves to.
  const currentBin = process.argv[1] ? await resolveRealPath(process.argv[1]) : null;

  // Probe all candidate dirs in parallel (each probeVersion already has a 5 s timeout).
  const candidates = candidateDirs.map((dir) => path.join(dir, binName));
  const probeResults = await Promise.all(
    candidates.map(async (candidate) => {
      if (!(await fileExists(candidate))) return null;
      const realPath = await resolveRealPath(candidate);
      const version = await probeVersion(candidate);
      return { candidate, realPath, version };
    }),
  );

  for (const result of probeResults) {
    if (!result) continue;
    const { candidate, realPath, version } = result;
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    installations.push({
      binPath: candidate,
      version,
      isCurrent: currentBin !== null && realPath === currentBin,
    });
  }

  return installations;
}

function shortenHome(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home + path.sep)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function buildRemediationHint(install: OpenClawInstallation): string {
  const p = install.binPath;
  if (
    p.startsWith("/usr/lib/node_modules/") ||
    p.startsWith("/usr/bin/") ||
    p.startsWith("/usr/local/")
  ) {
    return `sudo npm uninstall -g openclaw`;
  }
  if (p.includes(".npm-global")) {
    return `npm uninstall -g openclaw`;
  }
  if (p.includes(".volta")) {
    return `volta uninstall openclaw`;
  }
  // Managed version managers — use their first-class uninstall commands rather than bare rm,
  // which would leave dangling shims and break the package manager's internal bookkeeping.
  if (p.includes("pnpm")) {
    return `pnpm remove -g openclaw`;
  }
  if (p.includes(".nvm")) {
    return `nvm exec node npm uninstall -g openclaw`;
  }
  if (p.includes("fnm")) {
    return `fnm exec -- npm uninstall -g openclaw`;
  }
  return `rm ${shortenHome(p)}`;
}

export async function noteDuplicateInstallations(): Promise<DuplicateInstallResult> {
  const installations = await findOpenClawInstallations(
    process.env as Record<string, string | undefined>,
  );
  const warnings: string[] = [];

  if (installations.length <= 1) {
    return { installations, warnings };
  }

  const lines: string[] = [];
  lines.push(`Found ${installations.length} openclaw binaries:`);
  for (const inst of installations) {
    const versionStr = inst.version ? `v${inst.version}` : "unknown version";
    const currentTag = inst.isCurrent ? " ← current" : "";
    lines.push(`- ${shortenHome(inst.binPath)} (${versionStr})${currentTag}`);
  }

  lines.push("");
  lines.push("Multiple installations can cause gateway port conflicts and infinite restart loops.");

  // Suggest removing the non-current ones.
  // Guard: if no installation is identified as current (process.argv[1] didn't match any
  // discovered binary), isCurrent will be false for ALL of them. In that case, do NOT
  // emit removal hints — we can't tell which one is the running binary, so recommending
  // removal of all of them would be dangerous.
  const hasCurrent = installations.some((i) => i.isCurrent);
  const stale = installations.filter((i) => !i.isCurrent);
  if (hasCurrent && stale.length > 0) {
    lines.push("Remove the stale installation(s):");
    for (const s of stale) {
      lines.push(`  ${buildRemediationHint(s)}`);
    }
  } else if (!hasCurrent && stale.length > 0) {
    lines.push(
      "Could not identify which installation is currently running. " +
        "Inspect the list above and manually remove unwanted copies.",
    );
  }

  note(lines.join("\n"), "Duplicate installations");
  warnings.push(...lines);

  return { installations, warnings };
}
