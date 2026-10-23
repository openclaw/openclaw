import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { filterStringRecord } from "@openclaw/normalization-core/record-coerce";
import { detectPackageManager } from "./detect-package-manager.js";
import { readPackageManagerSpec } from "./package-json.js";
import { applyPathPrepend } from "./path-prepend.js";

type BuildManager = "pnpm" | "bun" | "npm";

export function resolvePnpmCandidateEnv(
  env: NodeJS.ProcessEnv | undefined,
  virtualStoreDir: string,
): NodeJS.ProcessEnv {
  // A shared project store lets candidate installation prune the serving generation.
  // Set every spelling: inherited lower-case keys can win over upper-case overrides.
  return {
    ...env,
    // pnpm 12 selects the global graph independently of virtualStoreDir. Its
    // hoisted/global materializer can also emit unpatched registry bytes while
    // recording the patch hash. Candidates need the project materializer.
    PNPM_CONFIG_VIRTUAL_STORE_TYPE: "project",
    pnpm_config_virtual_store_type: "project",
    NPM_CONFIG_VIRTUAL_STORE_TYPE: "project",
    npm_config_virtual_store_type: "project",
    PNPM_CONFIG_VIRTUAL_STORE_DIR: virtualStoreDir,
    pnpm_config_virtual_store_dir: virtualStoreDir,
    NPM_CONFIG_VIRTUAL_STORE_DIR: virtualStoreDir,
    npm_config_virtual_store_dir: virtualStoreDir,
  };
}

type UpdatePackageManagerFailureReason =
  | "preferred-manager-unavailable"
  | "pnpm-corepack-enable-failed"
  | "pnpm-corepack-missing"
  | "pnpm-npm-bootstrap-failed";

type PackageManagerCommandRunner = (
  argv: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type ResolvedBuildManager =
  | {
      kind: "resolved";
      manager: BuildManager;
      fallback: boolean;
      env?: NodeJS.ProcessEnv;
      cleanup?: () => Promise<void>;
    }
  | {
      kind: "missing-required";
      preferred: BuildManager;
      reason: UpdatePackageManagerFailureReason;
    };

async function isManagerAvailable(
  runCommand: PackageManagerCommandRunner,
  manager: BuildManager | "corepack",
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  expectedVersion?: string,
): Promise<boolean> {
  try {
    const res = await runCommand([manager, "--version"], { timeoutMs, env });
    return res.code === 0 && (!expectedVersion || res.stdout.trim() === expectedVersion);
  } catch {
    return false;
  }
}

export function parsePnpmPackageManagerVersion(pin: string | null): string | undefined {
  return /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/u.exec(pin ?? "")?.[1];
}

function pnpmCommandEnv(env: NodeJS.ProcessEnv | undefined, root: string): Record<string, string> {
  return {
    ...filterStringRecord(env ?? process.env),
    // Bind pnpm's manifest and lock owners even when inherited options name another checkout.
    NPM_CONFIG_WORKSPACE_DIR: root,
    npm_config_workspace_dir: root,
    PNPM_CONFIG_LOCKFILE_DIR: root,
    pnpm_config_lockfile_dir: root,
    COREPACK_ENABLE_PROJECT_SPEC: "1",
    COREPACK_DEFAULT_TO_LATEST: "0",
  };
}

export async function resolveUpdateBuildManager(
  commandRunner: PackageManagerCommandRunner,
  root: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
  work?: { timeoutMs?: number },
): Promise<ResolvedBuildManager> {
  const runCommand: PackageManagerCommandRunner = (argv, options) =>
    commandRunner(argv, { ...options, cwd: root });
  const preferred = (await detectPackageManager(root)) ?? "npm";
  const pin = await readPackageManagerSpec(root);
  const pnpmVersion = parsePnpmPackageManagerVersion(pin);
  if (preferred === "pnpm") {
    let cleanup: (() => Promise<void>) | undefined;
    let retained = false;
    let reason: UpdatePackageManagerFailureReason = "pnpm-corepack-missing";
    try {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pnpm-"));
      cleanup = async () => {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      };
      const targetEnv = pnpmCommandEnv(baseEnv, root);
      const probeEnv = pnpmCommandEnv(baseEnv, tempRoot);
      const probeCommand: PackageManagerCommandRunner = (argv, options) =>
        commandRunner(argv, { ...options, cwd: tempRoot });
      // An ambient pnpm can rewrite a lockfile before switching versions, even for --version.
      // Keep its probe unpinned and outside any ancestor pnpm workspace.
      await fs.writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ private: true }));
      await fs.writeFile(path.join(tempRoot, "pnpm-workspace.yaml"), "packages: []\n");
      if (await isManagerAvailable(probeCommand, "pnpm", timeoutMs, probeEnv, pnpmVersion)) {
        return { kind: "resolved", manager: "pnpm", fallback: false, env: targetEnv };
      }

      if (await isManagerAvailable(probeCommand, "corepack", timeoutMs, probeEnv)) {
        reason = "pnpm-corepack-enable-failed";
        try {
          const enabled = await probeCommand(
            ["corepack", "enable", "--install-directory", tempRoot, "pnpm"],
            { timeoutMs: work ? work.timeoutMs : timeoutMs, env: probeEnv },
          );
          const env = { ...targetEnv };
          applyPathPrepend(env, [tempRoot]);
          // This owned shim selects the checkout's full pin before executing pnpm.
          if (
            enabled.code === 0 &&
            (await isManagerAvailable(runCommand, "pnpm", timeoutMs, env, pnpmVersion))
          ) {
            retained = true;
            return { kind: "resolved", manager: "pnpm", fallback: false, env, cleanup };
          }
        } catch {
          // An unavailable Corepack download can still use the npm bootstrap below.
        }
      }

      if (pnpmVersion && (await isManagerAvailable(probeCommand, "npm", timeoutMs, probeEnv))) {
        reason = "pnpm-npm-bootstrap-failed";
        // npm 11.16+ requires project policy for the pinned tool's provisioning script.
        await fs.writeFile(
          path.join(tempRoot, "package.json"),
          JSON.stringify({ private: true, allowScripts: { [`pnpm@${pnpmVersion}`]: true } }),
        );
        const installed = await probeCommand(
          ["npm", "install", "--prefix", tempRoot, `pnpm@${pnpmVersion}`],
          { timeoutMs: work ? work.timeoutMs : timeoutMs, env: probeEnv },
        );
        const env = { ...targetEnv };
        applyPathPrepend(env, [path.join(tempRoot, "node_modules", ".bin")]);
        if (
          installed.code === 0 &&
          (await isManagerAvailable(
            probeCommand,
            "pnpm",
            timeoutMs,
            pnpmCommandEnv(env, tempRoot),
            pnpmVersion,
          ))
        ) {
          retained = true;
          return { kind: "resolved", manager: "pnpm", fallback: false, env, cleanup };
        }
      }
    } catch {
      // Preparation failures keep the existing visible failure result and cleanup owner.
    } finally {
      if (!retained) {
        await cleanup?.();
      }
    }
    return { kind: "missing-required", preferred, reason };
  }

  const managers: BuildManager[] =
    preferred === "bun" ? ["bun", "npm", "pnpm"] : ["npm", "pnpm", "bun"];
  for (const manager of managers) {
    if (
      await isManagerAvailable(
        runCommand,
        manager,
        timeoutMs,
        baseEnv,
        manager === "pnpm" ? pnpmVersion : undefined,
      )
    ) {
      return { kind: "resolved", manager, fallback: manager !== preferred };
    }
  }

  return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
}
