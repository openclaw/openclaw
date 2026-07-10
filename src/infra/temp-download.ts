// Creates private temporary workspaces for downloads.
import "./fs-safe-defaults.js";
import crypto from "node:crypto";
import { tmpdir as getOsTmpDir } from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tempWorkspace, type TempWorkspace } from "./private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const logger = createSubsystemLogger("infra:temp-download");

export { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

// Download targets expose both a default path and a name-safe file builder so
// callers can keep all transient files inside the same workspace.
type TempDownloadTarget = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** Known shared system temp directories that must never be chmod'd directly. */
const SHARED_SYSTEM_TMP_DIRS = new Set(["/tmp", "/private/tmp", "/var/tmp", "/dev/shm"]);

function resolveTempRoot(tmpDir?: string): string {
  return tmpDir ?? resolvePreferredOpenClawTmpDir();
}

/** Redirects bare system temp directory to a subdirectory to avoid corrupting shared temp permissions. */
function resolveSecureTempRoot(tmpDir?: string): string {
  const root = resolveTempRoot(tmpDir);
  // When callers pass the bare system temp directory (e.g. os.tmpdir()),
  // redirect to a subdirectory so ensurePrivateDirectory does not chmod
  // the shared system temp dir. resolvePreferredOpenClawTmpDir already
  // handles this by preferring /tmp/openclaw, but callers that pass
  // tmpDir directly bypass it.
  if (SHARED_SYSTEM_TMP_DIRS.has(root) || root === getOsTmpDir()) {
    return path.join(root, "openclaw");
  }
  return root;
}

function sanitizeTempPrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

function sanitizeTempExtension(extension?: string): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "";
  const token = suffix.replace(/^[._-]+/, "");
  return token ? `.${token}` : "";
}

export function sanitizeTempFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const normalized = base.replace(/^-+|-+$/g, "");
  return normalized || "download.bin";
}

/** Build a stable temp path shape while keeping caller-controlled text filename-safe. */
export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return path.join(
    resolveTempRoot(params.tmpDir),
    `${sanitizeTempPrefix(params.prefix)}-${now}-${uuid}${sanitizeTempExtension(params.extension)}`,
  );
}

function buildTempDownloadTarget(
  workspace: TempWorkspace,
  fileName: string | undefined,
): TempDownloadTarget {
  const file = (nextName?: string) =>
    workspace.path(sanitizeTempFileName(nextName ?? fileName ?? "download.bin"));
  return {
    dir: workspace.dir,
    path: file(),
    file,
    cleanup: async () => {
      await workspace.cleanup();
    },
    [Symbol.asyncDispose]: workspace[Symbol.asyncDispose].bind(workspace),
  };
}

export async function createTempDownloadTarget(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}): Promise<TempDownloadTarget> {
  const workspace = await tempWorkspace({
    rootDir: resolveSecureTempRoot(params.tmpDir),
    prefix: sanitizeTempPrefix(params.prefix),
  });
  const target = buildTempDownloadTarget(workspace, params.fileName);
  const cleanup = async () => {
    try {
      await workspace.cleanup();
    } catch (err) {
      logger.warn(`temp-path cleanup failed: ${String(err)}`, { error: err });
    }
  };
  return {
    ...target,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

/** Run with a private temp download path and always attempt workspace cleanup. */
export async function withTempDownloadPath<T>(
  params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await createTempDownloadTarget(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}
