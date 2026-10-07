import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../gateway/control-ui-root-assets.js";
import { selectControlUiRoutePreloads } from "../gateway/control-ui-route-preloads.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "./boundary-file-read.js";
import { FsSafeError } from "./fs-safe.js";
import { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } from "./openclaw-root.js";

export function formatControlUiSourceCommand(root: string, action: "build" | "dev"): string {
  const directory = process.platform === "win32" ? quotePowerShellArg(root) : quoteCliArg(root);
  return `pnpm --dir ${directory} ui:${action}`;
}

export function resolveControlUiDistIndexPathForRoot(root: string): string {
  return path.join(root, "dist", "control-ui", "index.html");
}

type ControlUiAssetHealth =
  | { kind: "missing-index"; indexPath: string | null }
  | { kind: "incomplete"; indexPath: string; missingAsset: string }
  | { kind: "stale"; indexPath: string; buildId: string | null }
  | { kind: "ready"; indexPath: string; publicAssetBuildId?: string };

export async function resolveControlUiAssetHealth(
  opts: {
    root?: string;
    argv1?: string;
    moduleUrl?: string;
    expectedBuildId?: string | null;
  } = {},
): Promise<ControlUiAssetHealth> {
  const indexPath = opts.root
    ? resolveControlUiDistIndexPathForRoot(opts.root)
    : await resolveControlUiDistIndexPath({
        argv1: opts.argv1 ?? process.argv[1],
        moduleUrl: opts.moduleUrl,
      });
  return inspectControlUiAssetHealth(indexPath, opts.expectedBuildId);
}

function resolveControlUiRepoRoot(opts: {
  root?: string;
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
}): string | null {
  const cwd = opts.cwd ?? process.cwd();
  const roots = opts.root
    ? [path.resolve(opts.root)]
    : [
        resolveOpenClawPackageRootSync({
          argv1: opts.argv1 ?? process.argv[1],
          moduleUrl: opts.moduleUrl ?? import.meta.url,
          cwd,
        }),
        resolveOpenClawPackageRootSync({ cwd }),
      ];
  return (
    roots.find(
      (root): root is string =>
        root !== null && fs.existsSync(path.join(root, "ui", "vite.config.ts")),
    ) ?? null
  );
}

function tryRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function resolveControlUiEntrypointPaths(argv1: string): string[] {
  const normalized = path.resolve(argv1);
  const realpath = tryRealpath(normalized);
  return realpath && realpath !== normalized ? [normalized, realpath] : [normalized];
}

async function resolveControlUiDistIndexPath(
  opts: ControlUiRootResolveOptions,
): Promise<string | null> {
  const argv1 = opts.argv1 ?? process.argv[1];
  const moduleUrl = opts.moduleUrl;
  if (!argv1) {
    return null;
  }
  const entrypointCandidates = resolveControlUiEntrypointPaths(argv1);

  // Case 1: entrypoint is directly inside dist/ (e.g., dist/entry.js).
  // Include symlink-resolved argv1 so global wrappers (e.g. Bun) still map to dist/control-ui.
  for (const entrypoint of entrypointCandidates) {
    const distDir = path.dirname(entrypoint);
    if (path.basename(distDir) === "dist") {
      return path.join(distDir, "control-ui", "index.html");
    }
  }

  const packageRoot = await resolveOpenClawPackageRoot({
    argv1: path.resolve(argv1),
    moduleUrl,
  });
  if (packageRoot) {
    return path.join(packageRoot, "dist", "control-ui", "index.html");
  }

  // Fallback: traverse up and find package.json with name "openclaw" + dist/control-ui/index.html
  // This handles global installs where path-based resolution might fail.
  const fallbackStartDirs = new Set(
    entrypointCandidates.map((candidate) => path.dirname(candidate)),
  );
  for (const startDir of fallbackStartDirs) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
      const pkgJsonPath = path.join(dir, "package.json");
      const indexPath = path.join(dir, "dist", "control-ui", "index.html");
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const raw = fs.readFileSync(pkgJsonPath, "utf-8");
          const parsed = JSON.parse(raw) as { name?: unknown };
          if (parsed.name === "openclaw") {
            return fs.existsSync(indexPath) ? indexPath : null;
          }
          // Stop at the first package boundary to avoid resolving through unrelated ancestors.
          break;
        } catch {
          // Invalid package.json at package boundary; abort this candidate chain.
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return null;
}

type ControlUiRootResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

function pathsMatchByRealpathOrResolve(left: string, right: string): boolean {
  return (tryRealpath(left) ?? path.resolve(left)) === (tryRealpath(right) ?? path.resolve(right));
}

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
  const entrypointPaths = argv1 ? resolveControlUiEntrypointPaths(argv1) : [];
  const execPath = tryRealpath(opts.execPath ?? process.execPath);
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });

  // Support legacy packaged runtimes that place assets alongside the executable.
  addCandidate(candidates, execPath ? path.join(path.dirname(execPath), "control-ui") : null);
  if (moduleDir) {
    // dist/<bundle>.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "control-ui"));
    // dist/gateway/control-ui.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../control-ui"));
    // src/gateway/control-ui.ts -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../../dist/control-ui"));
  }
  // Keep the lexical launcher before its target for symlinked global wrappers.
  for (const entrypoint of entrypointPaths) {
    const directory = path.dirname(entrypoint);
    addCandidate(candidates, path.join(directory, "dist", "control-ui"));
    addCandidate(candidates, path.join(directory, "control-ui"));
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

export function isPackageProvenControlUiRootSync(
  root: string,
  opts: ControlUiRootResolveOptions = {},
): boolean {
  const argv1 = opts.argv1 ?? process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });
  if (!packageRoot) {
    return false;
  }
  const packageDistRoot = path.join(packageRoot, "dist", "control-ui");
  return pathsMatchByRealpathOrResolve(root, packageDistRoot);
}

type EnsureControlUiAssetsResult =
  | { ok: true; built: boolean; assets: Extract<ControlUiAssetHealth, { kind: "ready" }> }
  | { ok: false; built: boolean; message: string };

type EnsureControlUiAssetsOptions = ControlUiRootResolveOptions & {
  root?: string;
  assetRoot?: string;
  expectedBuildId?: string | null;
  force?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onBuildStart?: () => void;
};

export const CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS = 10 * 60_000;

function controlUiAssetsFailure(message: string, built = false): EnsureControlUiAssetsResult {
  return { ok: false, built, message };
}

function inspectControlUiAssetHealth(
  indexPath: string | null,
  expectedBuildId?: string | null,
): ControlUiAssetHealth {
  if (!indexPath) {
    return { kind: "missing-index", indexPath };
  }
  let html: string;
  try {
    const opened = openRootFileSync({
      absolutePath: indexPath,
      rootPath: path.dirname(indexPath),
      boundaryLabel: "control ui root",
      rejectSymlinks: false,
      rejectHardlinks: false,
      maxBytes: 256 * 1024,
    });
    if (!opened.ok) {
      if (opened.error instanceof FsSafeError && opened.error.code === "too-large") {
        throw opened.error;
      }
      return { kind: "missing-index", indexPath };
    }
    try {
      html = readFileDescriptorBoundedSync(opened.fd, 256 * 1024).toString("utf8");
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error instanceof FsSafeError && error.code === "too-large")
    ) {
      return { kind: "incomplete", indexPath, missingAsset: "index.html exceeds its size limit" };
    }
    return { kind: "missing-index", indexPath };
  }
  // Route templates are mutually exclusive. Inspect the same documents the
  // Gateway serves, retaining the reference limit and integrity checks per page.
  const documents = new Set(
    ([null, "chat", "new"] as const).map((route) => selectControlUiRoutePreloads(html, route)),
  );
  for (const document of documents) {
    let references = 0;
    for (const tag of document.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
      const attribute = tag[0].match(/\s(?:href|src)\s*=\s*["']([^"']+)["']/iu);
      const reference = attribute?.[1]?.split(/[?#]/u, 1)[0]?.replace(/\\/gu, "/");
      if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference)) {
        continue;
      }
      const marker = reference.lastIndexOf("assets/");
      if (marker === -1 || !/\.(?:css|js)$/iu.test(reference)) {
        continue;
      }
      const asset = reference.slice(marker);
      if (++references > 128 || reference.split("/").includes("..")) {
        return {
          kind: "incomplete",
          indexPath,
          missingAsset: references > 128 ? "too many startup assets" : asset,
        };
      }
      if (!fs.existsSync(path.join(path.dirname(indexPath), asset))) {
        return { kind: "incomplete", indexPath, missingAsset: asset };
      }
    }
  }
  const publicAssetBuildId = new RegExp(
    `${CONTROL_UI_BUILD_ID_ATTRIBUTE}="([a-zA-Z0-9._-]{1,161})"`,
  ).exec(html)?.[1];
  // Vite appends a public-file digest to the runtime ID; the cache namespace
  // must not substitute for the identity used by same-origin admission.
  const buildId = publicAssetBuildId?.match(/^([a-zA-Z0-9._-]{1,96})-[a-f0-9]{64}$/u)?.[1] ?? null;
  if (expectedBuildId && buildId !== "dev" && buildId !== expectedBuildId) {
    return { kind: "stale", indexPath, buildId };
  }
  return { kind: "ready", indexPath, ...(publicAssetBuildId ? { publicAssetBuildId } : {}) };
}

export function inspectControlUiRootAssets(
  root: string,
  expectedBuildId?: string | null,
): ControlUiAssetHealth {
  return inspectControlUiAssetHealth(path.join(root, "index.html"), expectedBuildId);
}

function summarizeCommandOutput(text: string): string | undefined {
  const lines = normalizeStringEntries(
    stripAnsi(text)
      .split(/\r?\n/g)
      .map((line) => sanitizeTerminalText(line.trim())),
  );
  if (!lines.length) {
    return undefined;
  }
  // Keep the error and its context, not a warning preamble or a stack/object tail.
  const errorIndex = lines.findIndex((line) =>
    /^(?:\[[^\]]+\]\s*)?(?:\w*error|fatal)\b/iu.test(line),
  );
  const summary = lines.slice(Math.max(0, errorIndex)).join(" ");
  return summary.length > 240 ? `${truncateUtf16Safe(summary, 239)}…` : summary;
}

export async function ensureControlUiAssetsBuilt(
  runtime: RuntimeEnv = defaultRuntime,
  opts: EnsureControlUiAssetsOptions = {},
): Promise<EnsureControlUiAssetsResult> {
  const assetRoot =
    opts.assetRoot ??
    (opts.root
      ? path.dirname(resolveControlUiDistIndexPathForRoot(opts.root))
      : resolveControlUiRootSync(opts));
  const selectedIndex = assetRoot
    ? path.join(assetRoot, "index.html")
    : await resolveControlUiDistIndexPath(opts);
  const health = inspectControlUiAssetHealth(selectedIndex, opts.expectedBuildId);
  if (!opts.force && health.kind === "ready") {
    return { ok: true, built: false, assets: health };
  }

  const repoRoot = resolveControlUiRepoRoot(opts);
  const indexPath = repoRoot ? resolveControlUiDistIndexPathForRoot(repoRoot) : null;
  // Only the selected source tree owns its output. A healthy checkout beside a
  // damaged app's Resources directory cannot repair the assets that app serves.
  if (
    !repoRoot ||
    !indexPath ||
    (assetRoot && !pathsMatchByRealpathOrResolve(assetRoot, path.dirname(indexPath)))
  ) {
    const location = selectedIndex ? ` at ${selectedIndex}` : "";
    const hint =
      health.kind === "stale"
        ? `Stale Control UI assets${location} (build ${health.buildId ?? "unknown"}; expected ${opts.expectedBuildId})`
        : health.kind === "incomplete"
          ? `Incomplete Control UI assets${location} (missing ${health.missingAsset})`
          : `Missing Control UI assets${location}`;
    return controlUiAssetsFailure(
      `${hint}. Reinstall OpenClaw to restore bundled Control UI assets.`,
    );
  }

  const uiScript = path.join(repoRoot, "scripts", "ui.js");
  if (!fs.existsSync(uiScript)) {
    return controlUiAssetsFailure(`Control UI assets missing but ${uiScript} is unavailable.`);
  }

  if (opts.signal?.aborted) {
    return controlUiAssetsFailure("Control UI build canceled.");
  }

  if (opts.onBuildStart) {
    opts.onBuildStart();
  } else {
    const buildCommand = formatControlUiSourceCommand(repoRoot, "build");
    const devCommand = formatControlUiSourceCommand(repoRoot, "dev");
    runtime.log(
      `Control UI assets need rebuilding; building them now (rerun \`${buildCommand}\` after UI changes, or use \`${devCommand}\` while developing the Control UI)…`,
    );
  }

  let build: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    build = await runCommandWithTimeout([process.execPath, uiScript, "build"], {
      cwd: repoRoot,
      timeoutMs: opts.timeoutMs ?? CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return controlUiAssetsFailure(
      `Control UI build failed: ${summarizeCommandOutput(message) ?? "unknown error"}`,
    );
  }
  if (build.termination === "signal") {
    return controlUiAssetsFailure("Control UI build canceled.");
  }
  if (build.termination === "timeout" || build.termination === "no-output-timeout") {
    return controlUiAssetsFailure("Control UI build timed out.");
  }
  if (build.code !== 0) {
    return controlUiAssetsFailure(
      `Control UI build failed: ${summarizeCommandOutput(build.stderr) ?? `exit ${build.code}`}`,
    );
  }

  const builtHealth = inspectControlUiAssetHealth(indexPath, opts.expectedBuildId);
  if (builtHealth.kind !== "ready") {
    const issue =
      builtHealth.kind === "missing-index"
        ? `${indexPath} is still missing.`
        : builtHealth.kind === "incomplete"
          ? `startup asset ${builtHealth.missingAsset} is missing.`
          : `its identity is ${builtHealth.buildId ?? "unknown"}; expected ${opts.expectedBuildId}. Restart the Gateway after rebuilding its runtime and UI together.`;
    return controlUiAssetsFailure(`Control UI build completed but ${issue}`, true);
  }
  return { ok: true, built: true, assets: builtHealth };
}
