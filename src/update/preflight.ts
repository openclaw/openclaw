import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { satisfies } from "semver";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { gitCleanCheckArgs } from "../infra/update-runner-git-commands.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { UpdateTarget } from "./target.js";

export type PreflightResult = { ok: true } | { ok: false; reason: string; message: string };

/** Enumerate files without opening a database or admitting a schema migration. */
export async function listStateDatabases(stateDir: string): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (visited.has(real)) {
      return;
    }
    visited.add(real);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      // Tools leave dangling links in agent homes (Codex arg0 shims); they hold no database.
      const stat = await fs.stat(file).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
      if (!stat) {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(file);
      } else if (entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) {
        files.push(file);
      }
    }
  };
  await walk(path.join(stateDir, "state"));
  await walk(path.join(stateDir, "agents"));
  return files;
}

async function existingAncestor(file: string): Promise<string> {
  for (let current = file; ; current = path.dirname(current)) {
    try {
      await fs.access(current);
      return current;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") || path.dirname(current) === current) {
        throw error;
      }
    }
  }
}

export async function preflight(params: {
  kind: UpdateTarget["kind"];
  target: UpdateTarget;
  prefix: string;
  stateDir: string;
  node?: string;
  env?: NodeJS.ProcessEnv;
  statfs?: (file: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}): Promise<PreflightResult> {
  const env = params.env ?? process.env;
  const refuse = (reason: string, message: string): PreflightResult => ({
    ok: false,
    reason,
    message,
  });
  let reason = "unsupported-install";
  try {
    const containerMarker = await fs.access("/.dockerenv").then(
      () => true,
      (error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    );
    if (containerMarker || env.container || env.DOCKER_CONTAINER || env.OPENCLAW_CONTAINER) {
      return refuse(
        "container-install",
        "This installation belongs to a container image. Update the image instead.",
      );
    }
    const ancestor = await existingAncestor(params.prefix);
    const installPath =
      params.target.kind === "git"
        ? params.target.checkout
        : ((await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url })) ?? params.prefix);
    const realInstallPath = await fs.realpath(await existingAncestor(installPath));
    if (env.IN_NIX_SHELL || /(?:^|[\\/])nix[\\/]store[\\/]/u.test(realInstallPath)) {
      return refuse("nix-install", "This installation belongs to Nix. Update it with Nix instead.");
    }
    if (/(?:^|[\\/])(?:Cellar|Homebrew)[\\/]/u.test(realInstallPath)) {
      return refuse(
        "homebrew-install",
        "This installation belongs to Homebrew. Run brew upgrade openclaw instead.",
      );
    }
    reason = "prefix-not-writable";
    await fs.access(ancestor, constants.W_OK);
    reason = "missing-tool";
    const tools = params.kind === "git" ? ["git", "pnpm"] : ["npm"];
    for (const tool of tools) {
      const result = await runCommandWithTimeout([tool, "--version"], {
        env,
        timeoutMs: 10_000,
        killProcessTree: true,
      });
      if (result.code !== 0) {
        return refuse(
          reason,
          `Required tool ${tool} is unavailable. Install it and retry the update.`,
        );
      }
    }
    if (params.target.kind === "git") {
      // The release builds from the commit; local edits would silently stop running.
      reason = "dirty";
      const status = await runCommandWithTimeout(gitCleanCheckArgs(params.target.checkout), {
        env,
        timeoutMs: 30_000,
        killProcessTree: true,
      });
      if (status.code !== 0 || status.stdout.trim()) {
        return refuse(
          reason,
          "This checkout has local changes. Commit your changes and retry, or run `openclaw triage` for help.",
        );
      }
    }
    reason = "target-metadata-unavailable";
    const metadata = await runCommandWithTimeout(
      params.target.kind === "git"
        ? ["git", "-C", params.target.checkout, "show", `${params.target.sha}:package.json`]
        : ["npm", "view", params.target.spec, "engines", "--json"],
      { env, timeoutMs: 30_000, killProcessTree: true },
    );
    if (metadata.code !== 0) {
      return refuse(
        reason,
        metadata.stderr.slice(-8192) || "Could not read the target's Node requirements.",
      );
    }
    const parsed: { engines?: { node?: string }; node?: string } = JSON.parse(
      metadata.stdout || "{}",
    );
    const engine = params.target.kind === "git" ? parsed.engines?.node : parsed.node;
    const node = params.node ?? process.execPath;
    const runtime = await runCommandWithTimeout([node, "--version"], {
      env,
      timeoutMs: 10_000,
      killProcessTree: true,
    });
    if (
      runtime.code !== 0 ||
      (engine && !satisfies(runtime.stdout.trim(), engine, { includePrerelease: true }))
    ) {
      return refuse(
        "node-engine-mismatch",
        `The new release requires Node ${engine ?? "(unavailable)"}; the service uses ${runtime.stdout.trim() || node}. Upgrade the service's Node and retry.`,
      );
    }
    reason = "disk-space-unavailable";
    const statfs = params.statfs ?? fs.statfs;
    const available = async (file: string) => {
      const stat = await statfs(await existingAncestor(file));
      return BigInt(stat.bavail) * BigInt(stat.bsize);
    };
    if ((await available(params.prefix)) < 2n * 700n * 1024n * 1024n) {
      return refuse(
        "insufficient-install-space",
        "The update needs at least 1.4 GB free on the installation filesystem.",
      );
    }
    let stateBytes = 0n;
    for (const file of await listStateDatabases(params.stateDir)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          stateBytes += BigInt((await fs.stat(`${file}${suffix}`)).size);
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
        }
      }
    }
    if ((await available(params.stateDir)) < stateBytes) {
      return refuse(
        "insufficient-state-space",
        "Free space on the state filesystem must cover a copy of the state databases.",
      );
    }
    return { ok: true };
  } catch (error) {
    return refuse(reason, formatErrorMessage(error));
  }
}
