import fs from "node:fs/promises";
import path from "node:path";
import { satisfies } from "semver";
import { isBunRuntime } from "../daemon/runtime-binary.js";
import { extractArchive } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { PrepareResult } from "./prepare-git.js";

const PROJECT_ONLY_INSTALL_SCRIPTS = [
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

export async function preparePackage(params: {
  spec: string;
  staging: string;
  npm: string[];
  node: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onStep?: (name: string, status: "in_progress" | "completed") => void | Promise<void>;
}): Promise<PrepareResult> {
  const releaseRoot = path.join(params.staging, "openclaw");
  const deadline = Date.now() + params.timeoutMs;
  const baseEnv = params.env ?? process.env;
  const bun =
    isBunRuntime(params.node) ||
    (params.node === process.execPath && Boolean(process.versions.bun));
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PATH: `${path.dirname(params.node)}${path.delimiter}${baseEnv.PATH ?? ""}`,
  };
  // The old updater's marker makes Windows postinstall enter its migration path.
  delete env.OPENCLAW_UPDATE_IN_PROGRESS;
  let reason = "package-install-failed";
  try {
    await fs.mkdir(params.staging, { recursive: true });
    await params.onStep?.("pack", "in_progress");
    const packed = await runCommandWithTimeout(
      [...params.npm, "pack", params.spec, "--ignore-scripts", "--quiet"],
      {
        cwd: params.staging,
        baseEnv: env,
        timeoutMs: Math.max(1, deadline - Date.now()),
        killProcessTree: true,
      },
    );
    if (packed.code !== 0 || packed.killed || packed.signal) {
      throw new Error(packed.stderr || packed.stdout || `npm pack exited ${packed.code}`);
    }
    // The owned staging directory, not npm's potentially large/truncated stdout, owns the archive.
    const packages = (await fs.readdir(params.staging, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".tgz"),
    );
    const archive = packages[0];
    if (packages.length !== 1 || !archive) {
      throw new Error("npm pack did not produce one package archive.");
    }
    const archivePath = path.join(params.staging, archive.name);
    await fs.mkdir(releaseRoot);
    await extractArchive({
      archivePath,
      destDir: releaseRoot,
      kind: "tar",
      stripComponents: 1,
      timeoutMs: Math.max(1, deadline - Date.now()),
      tarGzip: true,
      durable: false,
    });
    await fs.rm(archivePath);
    await params.onStep?.("pack", "completed");
    const manifestPath = path.join(releaseRoot, "package.json");
    const manifest: {
      name?: string;
      version?: string;
      engines?: { node?: string };
      devDependencies?: unknown;
      workspaces?: unknown;
      scripts?: Record<string, string>;
    } = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest.name !== "openclaw") {
      throw new Error("Prepared archive is not the openclaw package.");
    }
    const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
    if (!version) {
      throw new Error("Prepared package has no package version.");
    }
    // Bun is admitted by its SQLite capability contract in preflight, not engines.node.
    if (!bun && manifest.engines?.node) {
      const runtime = await runCommandWithTimeout([params.node, "--version"], {
        baseEnv: env,
        timeoutMs: Math.max(1, deadline - Date.now()),
        killProcessTree: true,
      });
      if (
        runtime.code !== 0 ||
        runtime.killed ||
        runtime.signal ||
        !satisfies(runtime.stdout.trim(), manifest.engines.node, { includePrerelease: true })
      ) {
        reason = "node-engine-mismatch";
        throw new Error(
          `The new release requires Node ${manifest.engines.node}; the service uses ${runtime.stdout.trim() || params.node}. Upgrade the service's Node and retry.`,
        );
      }
    }
    // Root dev peers and checkout workspaces do not belong to the published runtime.
    // Preserve runtime install scripts, but not development/prepare hooks.
    let changed =
      Object.hasOwn(manifest, "devDependencies") || Object.hasOwn(manifest, "workspaces");
    delete manifest.devDependencies;
    delete manifest.workspaces;
    for (const name of PROJECT_ONLY_INSTALL_SCRIPTS) {
      if (manifest.scripts && Object.hasOwn(manifest.scripts, name)) {
        delete manifest.scripts[name];
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    // Bun also imports checkout workspaces from pnpm's configuration.
    await fs.rm(path.join(releaseRoot, "pnpm-workspace.yaml"), { force: true });
    await params.onStep?.("install", "in_progress");
    // Bun rejects --production with --trust; this manifest already has no development dependencies.
    const result = await runCommandWithTimeout(
      bun
        ? [params.node, "install", "--trust"]
        : [
            ...params.npm,
            "install",
            "--omit=dev",
            "--no-fund",
            "--no-audit",
            "--ignore-scripts=false",
          ],
      {
        cwd: releaseRoot,
        baseEnv: env,
        timeoutMs: Math.max(1, deadline - Date.now()),
        killProcessTree: true,
      },
    );
    if (result.code !== 0 || result.killed || result.signal) {
      throw new Error(
        result.stderr || result.stdout || `${bun ? "bun" : "npm"} exited ${result.code}`,
      );
    }
    await params.onStep?.("install", "completed");
    const buildId = await readBuiltGatewayBuildId(releaseRoot);
    return { ok: true, releaseRoot, version, ...(buildId ? { buildId } : {}) };
  } catch (error) {
    await fs.rm(params.staging, { recursive: true, force: true });
    return {
      ok: false,
      reason,
      stderrTail: formatErrorMessage(error).slice(-8192),
    };
  }
}
