import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fileExists } from "./archive.js";

/**
 * Remove `devDependencies` entries that use the pnpm `workspace:` protocol.
 *
 * Published npm packages from this monorepo may contain
 * `"openclaw": "workspace:*"` in their `devDependencies`.  The specifier is
 * only meaningful inside the pnpm workspace – plain `npm install` (even with
 * `--omit=dev`) fails to *parse* it, which causes every extension / hook
 * install from the npm registry to error out.
 *
 * Stripping these entries before `npm install` is safe because:
 *   1. We already pass `--omit=dev`, so dev-deps are never installed.
 *   2. The entries are only used for in-repo development builds.
 */
async function stripWorkspaceDevDeps(dir: string): Promise<void> {
  const pkgPath = path.join(dir, "package.json");
  const raw = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw);

  const devDeps: Record<string, string> | undefined = pkg.devDependencies;
  if (!devDeps) {
    return;
  }

  let changed = false;
  for (const [name, spec] of Object.entries(devDeps)) {
    if (typeof spec === "string" && spec.startsWith("workspace:")) {
      delete devDeps[name];
      changed = true;
    }
  }

  if (changed) {
    if (Object.keys(devDeps).length === 0) {
      delete pkg.devDependencies;
    }
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
}

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: () => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  let backupDir: string | null = null;
  if (params.mode === "update" && (await fileExists(params.targetDir))) {
    backupDir = `${params.targetDir}.backup-${Date.now()}`;
    await fs.rename(params.targetDir, backupDir);
  }

  const rollback = async () => {
    if (!backupDir) {
      return;
    }
    await fs.rm(params.targetDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rename(backupDir, params.targetDir).catch(() => undefined);
  };

  try {
    await fs.cp(params.sourceDir, params.targetDir, { recursive: true });
  } catch (err) {
    await rollback();
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }

  try {
    await params.afterCopy?.();
  } catch (err) {
    await rollback();
    return { ok: false, error: `post-copy validation failed: ${String(err)}` };
  }

  if (params.hasDeps) {
    params.logger?.info?.(params.depsLogMessage);
    await stripWorkspaceDevDeps(params.targetDir);
    const npmRes = await runCommandWithTimeout(
      ["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"],
      {
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        cwd: params.targetDir,
      },
    );
    if (npmRes.code !== 0) {
      await rollback();
      return {
        ok: false,
        error: `npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`,
      };
    }
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true };
}
