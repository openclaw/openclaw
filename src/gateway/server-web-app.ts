import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayWebAppConfig } from "../config/types.gateway.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export const DEFAULT_WEB_APP_PORT = 3100;

export type WebAppHandle = {
  port: number;
  stop: () => Promise<void>;
};

/**
 * Resolve the `apps/web` directory relative to the package root.
 * Walks up from the current module until we find `apps/web/package.json`.
 */
export function resolveWebAppDir(): string | null {
  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "apps", "web");
    // Accept either package.json (dev workspace) or .next/standalone (production).
    if (
      fs.existsSync(path.join(candidate, "package.json")) ||
      fs.existsSync(path.join(candidate, ".next", "standalone"))
    ) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Check whether a pre-built Next.js standalone server exists.
 *
 * The standalone build is produced by `next build` with `output: "standalone"`
 * in `next.config.ts` and ships with the npm package. It includes a
 * self-contained `server.js` that can run without `node_modules` or `next`.
 */
export function hasStandaloneBuild(webAppDir: string): boolean {
  return fs.existsSync(resolveStandaloneServerJs(webAppDir));
}

/**
 * Resolve the standalone server.js path for the web app.
 *
 * With `outputFileTracingRoot` set to the monorepo root (required for
 * pnpm), the standalone output mirrors the repo directory structure.
 * `server.js` lives at `.next/standalone/apps/web/server.js`.
 */
export function resolveStandaloneServerJs(webAppDir: string): string {
  return path.join(webAppDir, ".next", "standalone", "apps", "web", "server.js");
}

/**
 * Check whether a classic Next.js production build exists (legacy).
 * Kept for backward compatibility with dev-workspace builds that haven't
 * switched to standalone yet.
 */
export function hasLegacyNextBuild(webAppDir: string): boolean {
  return fs.existsSync(path.join(webAppDir, ".next", "BUILD_ID"));
}

/**
 * Detect whether we're running inside a pnpm workspace (dev checkout)
 * vs. a standalone npm/global install. In a workspace, building at
 * runtime is safe because all deps are available. In a global install,
 * runtime builds are fragile and should not be attempted.
 */
export function isInWorkspace(webAppDir: string): boolean {
  const rootDir = path.resolve(webAppDir, "..", "..");
  return fs.existsSync(path.join(rootDir, "pnpm-workspace.yaml"));
}

// ── port detection ───────────────────────────────────────────────────────────

/**
 * Check whether a TCP port is free by attempting to bind a temporary server.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

/**
 * Find an available port, preferring `preferred`.
 *
 * 1. If `preferred` is free, return it immediately.
 * 2. Try up to 10 sequential ports (preferred+1 … preferred+10).
 * 3. Fall back to an OS-assigned ephemeral port.
 */
export async function findAvailablePort(preferred: number): Promise<number> {
  if (await isPortFree(preferred)) {
    return preferred;
  }
  for (let offset = 1; offset <= 10; offset++) {
    const candidate = preferred + offset;
    if (candidate <= 65535 && (await isPortFree(candidate))) {
      return candidate;
    }
  }
  // OS-assigned ephemeral port as last resort.
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ── pre-build ────────────────────────────────────────────────────────────────

export type EnsureWebAppBuiltResult = {
  ok: boolean;
  built: boolean;
  message?: string;
};

/**
 * Verify the Next.js web app is ready to serve.
 *
 * For production (npm global install): checks that the pre-built standalone
 * server exists. No runtime `npm install` or `next build` is performed —
 * the standalone build ships with the npm package via `prepack`.
 *
 * For dev workspaces: builds the web app if no build exists (safe because
 * all deps are available via the workspace). `next dev` compiles on-the-fly,
 * so no pre-build is needed when `dev` mode is enabled.
 *
 * Skips silently when the web app feature is disabled or `apps/web` is
 * not present.
 */
export async function ensureWebAppBuilt(
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { webAppConfig?: GatewayWebAppConfig },
): Promise<EnsureWebAppBuiltResult> {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_WEB_APP)) {
    return { ok: true, built: false };
  }
  if (opts?.webAppConfig && opts.webAppConfig.enabled === false) {
    return { ok: true, built: false };
  }
  // Dev mode uses `next dev` which compiles on-the-fly — no pre-build needed.
  if (opts?.webAppConfig?.dev) {
    return { ok: true, built: false };
  }

  const webAppDir = resolveWebAppDir();
  if (!webAppDir) {
    // No apps/web directory — nothing to verify.
    return { ok: true, built: false };
  }

  // Standalone build ships with the npm package; just verify it exists.
  if (hasStandaloneBuild(webAppDir)) {
    return { ok: true, built: false };
  }

  // Legacy: accept a classic .next/BUILD_ID build (dev workspace that
  // hasn't been rebuilt with standalone yet).
  if (hasLegacyNextBuild(webAppDir)) {
    return { ok: true, built: false };
  }

  // In a pnpm workspace, attempt to build — all deps are available.
  if (isInWorkspace(webAppDir)) {
    const log = {
      info: (msg: string) => runtime.log(msg),
      warn: (msg: string) => runtime.error(msg),
    };
    try {
      await ensureDevDepsInstalled(webAppDir, log);
      runtime.log("Web app not built; building for production (next build)…");
      await runCommand("node", [resolveNextBin(webAppDir), "build"], webAppDir, log);
    } catch (err) {
      return {
        ok: false,
        built: false,
        message: `Web app build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (hasStandaloneBuild(webAppDir) || hasLegacyNextBuild(webAppDir)) {
      return { ok: true, built: true };
    }
    return {
      ok: false,
      built: false,
      message: "Web app build completed but no build output found.",
    };
  }

  // Global npm install without a pre-built standalone — nothing we can do.
  return {
    ok: false,
    built: false,
    message:
      "Web app standalone build not found. " +
      "Reinstall the package to get the pre-built web app.",
  };
}

/**
 * Start the Ironclaw Next.js web app as a child process.
 *
 * Production mode (default):
 *   Uses the pre-built standalone server (`node server.js`). No runtime
 *   `npm install` or `next build` is needed — the standalone output ships
 *   with the npm package.
 *
 *   In a dev workspace without a standalone build, falls back to a classic
 *   `next start` (with legacy BUILD_ID) or builds on-the-fly.
 *
 * Dev mode (`gateway.webApp.dev: true`):
 *   Runs `next dev` from the workspace, installing deps if needed.
 *
 * Returns a handle whose `stop()` kills the running server.
 */
export async function startWebAppIfEnabled(
  cfg: GatewayWebAppConfig | undefined,
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<WebAppHandle | null> {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_WEB_APP)) {
    return null;
  }
  if (!cfg?.enabled) {
    return null;
  }

  const preferredPort = cfg.port ?? DEFAULT_WEB_APP_PORT;
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    log.info(`port ${preferredPort} is busy; using port ${port} instead`);
  }
  const devMode = cfg.dev === true;

  const webAppDir = resolveWebAppDir();
  if (!webAppDir) {
    log.warn("apps/web directory not found — skipping web app");
    return null;
  }

  let child: ChildProcess;

  if (devMode) {
    // Dev mode: ensure deps, then `next dev`.
    await ensureDevDepsInstalled(webAppDir, log);
    log.info(`starting web app (dev) on port ${port}…`);
    child = spawn("node", [resolveNextBin(webAppDir), "dev", "--port", String(port)], {
      cwd: webAppDir,
      stdio: "pipe",
      env: { ...process.env, PORT: String(port) },
    });
  } else {
    // Production: prefer standalone, fall back to legacy, then workspace build.
    const serverJs = resolveStandaloneServerJs(webAppDir);

    // The web app's agent-runner needs to find openclaw.mjs or
    // scripts/run-node.mjs to spawn agent processes.  In standalone mode
    // the server's cwd is deep inside .next/standalone/ so we pass the
    // actual package root via env so it doesn't have to guess.
    const packageRoot = path.resolve(webAppDir, "..", "..");

    if (fs.existsSync(serverJs)) {
      // Standalone build found — just run it (npm global install or post-build).
      log.info(`starting web app (standalone) on port ${port}…`);
      child = spawn("node", [serverJs], {
        cwd: path.dirname(serverJs),
        stdio: "pipe",
        env: {
          ...process.env,
          PORT: String(port),
          HOSTNAME: "0.0.0.0",
          OPENCLAW_ROOT: packageRoot,
        },
      });
    } else if (hasLegacyNextBuild(webAppDir)) {
      // Legacy build — use `next start` (dev workspace that hasn't rebuilt).
      log.warn("standalone build not found — falling back to legacy next start");
      await ensureDevDepsInstalled(webAppDir, log);
      child = spawn("node", [resolveNextBin(webAppDir), "start", "--port", String(port)], {
        cwd: webAppDir,
        stdio: "pipe",
        env: { ...process.env, PORT: String(port) },
      });
    } else if (isInWorkspace(webAppDir)) {
      // Dev workspace with no build at all — build first, then start.
      log.info("no web app build found — building in workspace…");
      await ensureDevDepsInstalled(webAppDir, log);
      await runCommand("node", [resolveNextBin(webAppDir), "build"], webAppDir, log);

      // After building, prefer standalone if the config produced it.
      if (fs.existsSync(serverJs)) {
        log.info(`starting web app (standalone) on port ${port}…`);
        child = spawn("node", [serverJs], {
          cwd: path.dirname(serverJs),
          stdio: "pipe",
          env: {
            ...process.env,
            PORT: String(port),
            HOSTNAME: "0.0.0.0",
            OPENCLAW_ROOT: packageRoot,
          },
        });
      } else {
        log.info(`starting web app (production) on port ${port}…`);
        child = spawn("node", [resolveNextBin(webAppDir), "start", "--port", String(port)], {
          cwd: webAppDir,
          stdio: "pipe",
          env: { ...process.env, PORT: String(port) },
        });
      }
    } else {
      // Global install with no standalone build — nothing we can safely do.
      log.error(
        "web app standalone build not found — reinstall the package to get the pre-built web app",
      );
      return null;
    }
  }

  // Collect stderr lines for crash diagnostics.
  const stderrLines: string[] = [];

  // Forward child stdout/stderr to the gateway log.
  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log.info(line);
    }
  });
  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      stderrLines.push(line);
      log.warn(line);
    }
  });

  child.on("error", (err) => {
    log.error(`web app process error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      log.error(`web app crashed (exit code ${code}) — http://localhost:${port} will not work`);
    } else if (signal) {
      log.info(`web app terminated by signal ${signal}`);
    }
  });

  // Wait briefly for the child to either settle or crash on startup.
  // Most fatal errors (missing modules, bad config) surface within a
  // couple of seconds. Without this, we'd log "web app available" even
  // though the process has already exited.
  const crashed = await waitForStartupOrCrash(child, 3_000);
  if (crashed) {
    const detail = stderrLines.length > 0 ? `: ${stderrLines.slice(-3).join(" | ")}` : "";
    log.error(`web app failed to start (exit code ${crashed.code})${detail}`);
    return null;
  }

  log.info(`web app available at http://localhost:${port}`);

  return {
    port,
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null && !child.killed) {
              child.kill("SIGKILL");
            }
            resolve();
          }, 5_000);
          child.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    },
  };
}

/**
 * Wait up to `timeoutMs` for the child process to either stay alive
 * (server started successfully) or exit (crash on startup).
 *
 * Returns null if the process is still running after the timeout,
 * or `{ code }` if it exited during the wait.
 */
function waitForStartupOrCrash(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null } | null> {
  // Already exited before we even started waiting.
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Still running after timeout — assume healthy.
      child.removeListener("exit", onExit);
      resolve(null);
    }, timeoutMs);
    function onExit(code: number | null) {
      clearTimeout(timer);
      resolve({ code });
    }
    child.once("exit", onExit);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the local `next` CLI entry script from apps/web/node_modules.
 * Only used in dev/workspace mode — production uses the standalone server.js.
 */
function resolveNextBin(webAppDir: string): string {
  return path.join(webAppDir, "node_modules", "next", "dist", "bin", "next");
}

/**
 * Install web app dependencies if needed (dev/workspace mode only).
 * Production standalone builds are self-contained and don't need this.
 */
async function ensureDevDepsInstalled(
  webAppDir: string,
  log: { info: (msg: string) => void },
): Promise<void> {
  const nextPkg = path.join(webAppDir, "node_modules", "next", "package.json");
  if (fs.existsSync(nextPkg)) {
    return;
  }

  // In a pnpm workspace, run `pnpm install` at the workspace root.
  const rootDir = path.resolve(webAppDir, "..", "..");
  const inWorkspace = fs.existsSync(path.join(rootDir, "pnpm-workspace.yaml"));

  if (inWorkspace) {
    log.info("installing web app dependencies (workspace)…");
    await runCommand("pnpm", ["install"], rootDir, log);
  } else {
    log.info("installing web app dependencies…");
    await runCommand("npm", ["install", "--legacy-peer-deps"], webAppDir, log);
  }
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  log?: { info: (msg: string) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "pipe", env: { ...process.env } });
    if (log) {
      proc.stdout?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          log.info(line);
        }
      });
      proc.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          log.info(line);
        }
      });
    }
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`)),
    );
    proc.on("error", reject);
  });
}
