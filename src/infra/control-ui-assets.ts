import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } from "./openclaw-root.js";

const CONTROL_UI_DIST_PATH_SEGMENTS = ["dist", "control-ui", "index.html"] as const;

export function resolveControlUiDistIndexPathForRoot(root: string): string {
  return path.join(root, ...CONTROL_UI_DIST_PATH_SEGMENTS);
}

export type ControlUiDistIndexHealth = {
  indexPath: string | null;
  exists: boolean;
};

export async function resolveControlUiDistIndexHealth(
  opts: {
    root?: string;
    argv1?: string;
  } = {},
): Promise<ControlUiDistIndexHealth> {
  const indexPath = opts.root
    ? resolveControlUiDistIndexPathForRoot(opts.root)
    : await resolveControlUiDistIndexPath(opts.argv1 ?? process.argv[1]);
  return {
    indexPath,
    exists: Boolean(indexPath && fs.existsSync(indexPath)),
  };
}

export function resolveControlUiRepoRoot(
  argv1: string | undefined = process.argv[1],
): string | null {
  if (!argv1) {
    return null;
  }
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex !== -1) {
    const root = parts.slice(0, srcIndex).join(path.sep);
    if (fs.existsSync(path.join(root, "ui", "vite.config.ts"))) {
      return root;
    }
  }

  let dir = path.dirname(normalized);
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "ui", "vite.config.ts"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export async function resolveControlUiDistIndexPath(
  argv1: string | undefined = process.argv[1],
): Promise<string | null> {
  if (!argv1) {
    return null;
  }
  const normalized = path.resolve(argv1);

  // Case 1: entrypoint is directly inside dist/ (e.g., dist/entry.js)
  const distDir = path.dirname(normalized);
  if (path.basename(distDir) === "dist") {
    return path.join(distDir, "control-ui", "index.html");
  }

  const packageRoot = await resolveOpenClawPackageRoot({ argv1: normalized });
  if (packageRoot) {
    return path.join(packageRoot, "dist", "control-ui", "index.html");
  }

  // Fallback: traverse up and find package.json with name "openclaw" + dist/control-ui/index.html
  // This handles global installs where path-based resolution might fail.
  let dir = path.dirname(normalized);
  for (let i = 0; i < 8; i++) {
    const pkgJsonPath = path.join(dir, "package.json");
    const indexPath = path.join(dir, "dist", "control-ui", "index.html");
    if (fs.existsSync(pkgJsonPath) && fs.existsSync(indexPath)) {
      try {
        const raw = fs.readFileSync(pkgJsonPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (parsed.name === "openclaw") {
          return indexPath;
        }
      } catch {
        // Invalid package.json, continue searching
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export type ControlUiRootResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

function addCandidate(candidates: Set<string>, value: string | null) {
  if (!value) {
    return;
  }
  candidates.add(path.resolve(value));
}

export function resolveControlUiRootOverrideSync(rootOverride: string): string | null {
  const resolved = path.resolve(rootOverride);
  try {
    const stats = fs.statSync(resolved);
    if (stats.isFile()) {
      return path.basename(resolved) === "index.html" ? path.dirname(resolved) : null;
    }
    if (stats.isDirectory()) {
      const indexPath = path.join(resolved, "index.html");
      return fs.existsSync(indexPath) ? resolved : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveControlUiRootSync(opts: ControlUiRootResolveOptions = {}): string | null {
  const candidates = new Set<string>();
  const argv1 = opts.argv1 ?? process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const moduleDir = opts.moduleUrl ? path.dirname(fileURLToPath(opts.moduleUrl)) : null;
  const argv1Dir = argv1 ? path.dirname(path.resolve(argv1)) : null;
  const execDir = (() => {
    try {
      const execPath = opts.execPath ?? process.execPath;
      return path.dirname(fs.realpathSync(execPath));
    } catch {
      return null;
    }
  })();
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });

  // Packaged app: control-ui lives alongside the executable.
  addCandidate(candidates, execDir ? path.join(execDir, "control-ui") : null);
  if (moduleDir) {
    // dist/<bundle>.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "control-ui"));
    // dist/gateway/control-ui.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../control-ui"));
    // src/gateway/control-ui.ts -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../../dist/control-ui"));
  }
  if (argv1Dir) {
    // openclaw.mjs or dist/<bundle>.js
    addCandidate(candidates, path.join(argv1Dir, "dist", "control-ui"));
    addCandidate(candidates, path.join(argv1Dir, "control-ui"));
  }
  if (packageRoot) {
    addCandidate(candidates, path.join(packageRoot, "dist", "control-ui"));
  }
  addCandidate(candidates, path.join(cwd, "dist", "control-ui"));

  for (const dir of candidates) {
    const indexPath = path.join(dir, "index.html");
    if (fs.existsSync(indexPath)) {
      return dir;
    }
  }
  return null;
}

export type EnsureControlUiAssetsResult = {
  ok: boolean;
  built: boolean;
  message?: string;
};

function summarizeCommandOutput(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  const last = lines.at(-1);
  if (!last) {
    return undefined;
  }
  return last.length > 240 ? `${last.slice(0, 239)}…` : last;
}

export async function ensureControlUiAssetsBuilt(
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { timeoutMs?: number },
): Promise<EnsureControlUiAssetsResult> {
  const health = await resolveControlUiDistIndexHealth({ argv1: process.argv[1] });
  const indexFromDist = health.indexPath;
  if (health.exists) {
    return { ok: true, built: false };
  }

  const repoRoot = resolveControlUiRepoRoot(process.argv[1]);
  if (!repoRoot) {
    const hint = indexFromDist
      ? `Missing Control UI assets at ${indexFromDist}`
      : "Missing Control UI assets";
    return {
      ok: false,
      built: false,
      message: `${hint}. Build them with \`pnpm ui:build\` (auto-installs UI deps).`,
    };
  }

  const indexPath = resolveControlUiDistIndexPathForRoot(repoRoot);
  if (fs.existsSync(indexPath)) {
    return { ok: true, built: false };
  }

  const uiScript = path.join(repoRoot, "scripts", "ui.js");
  if (!fs.existsSync(uiScript)) {
    return {
      ok: false,
      built: false,
      message: `Control UI assets missing but ${uiScript} is unavailable.`,
    };
  }

  runtime.log("Control UI assets missing; building (ui:build, auto-installs UI deps)…");

  const build = await runCommandWithTimeout([process.execPath, uiScript, "build"], {
    cwd: repoRoot,
    timeoutMs: opts?.timeoutMs ?? 10 * 60_000,
  });
  if (build.code !== 0) {
    return {
      ok: false,
      built: false,
      message: `Control UI build failed: ${summarizeCommandOutput(build.stderr) ?? `exit ${build.code}`}`,
    };
  }

  if (!fs.existsSync(indexPath)) {
    return {
      ok: false,
      built: true,
      message: `Control UI build completed but ${indexPath} is still missing.`,
    };
  }

  return { ok: true, built: true };
}
