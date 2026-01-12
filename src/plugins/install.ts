import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { runCommandWithTimeout } from "../process/exec.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  clawdbot?: { extensions?: string[] };
};

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      extensions: string[];
    }
  | { ok: false; error: string };

const defaultLogger: PluginInstallLogger = {};

function unscopedPackageName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.includes("/")
    ? (trimmed.split("/").pop() ?? trimmed)
    : trimmed;
}

function safeDirName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return trimmed.replaceAll("/", "__");
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePackedPackageDir(extractDir: string): Promise<string> {
  const direct = path.join(extractDir, "package");
  if (await fileExists(direct)) return direct;

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length !== 1) {
    throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
  }
  const onlyDir = dirs[0];
  if (!onlyDir) {
    throw new Error("unexpected archive layout (no package dir found)");
  }
  return path.join(extractDir, onlyDir);
}

async function ensureClawdbotExtensions(manifest: PackageManifest) {
  const extensions = manifest.clawdbot?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error("package.json missing clawdbot.extensions");
  }
  const list = extensions
    .map((e) => (typeof e === "string" ? e.trim() : ""))
    .filter(Boolean);
  if (list.length === 0) {
    throw new Error("package.json clawdbot.extensions is empty");
  }
  return list;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function installPluginFromArchive(params: {
  archivePath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;

  const archivePath = resolveUserPath(params.archivePath);
  if (!(await fileExists(archivePath))) {
    return { ok: false, error: `archive not found: ${archivePath}` };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-plugin-"));
  const extractDir = path.join(tmpDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });

  logger.info?.(`Extracting ${archivePath}…`);
  try {
    await withTimeout(
      tar.x({ file: archivePath, cwd: extractDir }),
      timeoutMs,
      "extract archive",
    );
  } catch (err) {
    return { ok: false, error: `failed to extract archive: ${String(err)}` };
  }

  let packageDir = "";
  try {
    packageDir = await resolvePackedPackageDir(extractDir);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const manifestPath = path.join(packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await readJsonFile<PackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  let extensions: string[];
  try {
    extensions = await ensureClawdbotExtensions(manifest);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const pluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";
  const targetDir = path.join(extensionsDir, safeDirName(pluginId));

  if (await fileExists(targetDir)) {
    return {
      ok: false,
      error: `plugin already exists: ${targetDir} (delete it first)`,
    };
  }

  logger.info?.(`Installing to ${targetDir}…`);
  await fs.cp(packageDir, targetDir, { recursive: true });

  for (const entry of extensions) {
    const resolvedEntry = path.resolve(targetDir, entry);
    if (!(await fileExists(resolvedEntry))) {
      logger.warn?.(`extension entry not found: ${entry}`);
    }
  }

  const deps = manifest.dependencies ?? {};
  const hasDeps = Object.keys(deps).length > 0;
  if (hasDeps) {
    logger.info?.("Installing plugin dependencies…");
    const npmRes = await runCommandWithTimeout(
      ["npm", "install", "--omit=dev", "--silent"],
      { timeoutMs: Math.max(timeoutMs, 300_000), cwd: targetDir },
    );
    if (npmRes.code !== 0) {
      return {
        ok: false,
        error: `npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`,
      };
    }
  }

  return {
    ok: true,
    pluginId,
    targetDir,
    manifestName: pkgName || undefined,
    extensions,
  };
}

export async function installPluginFromNpmSpec(params: {
  spec: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const spec = params.spec.trim();
  if (!spec) return { ok: false, error: "missing npm spec" };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-npm-pack-"));
  logger.info?.(`Downloading ${spec}…`);
  const res = await runCommandWithTimeout(["npm", "pack", spec], {
    timeoutMs: Math.max(timeoutMs, 300_000),
    cwd: tmpDir,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (res.code !== 0) {
    return {
      ok: false,
      error: `npm pack failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }

  const packed = (res.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!packed) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  const archivePath = path.join(tmpDir, packed);
  return await installPluginFromArchive({
    archivePath,
    extensionsDir: params.extensionsDir,
    timeoutMs,
    logger,
  });
}
