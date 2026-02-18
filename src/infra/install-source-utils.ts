import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { fileExists, resolveArchiveKind } from "./archive.js";

export async function withTempDir<T>(
  prefix: string,
  fn: (tmpDir: string) => Promise<T>,
): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function resolveArchiveSourcePath(archivePath: string): Promise<
  | {
      ok: true;
      path: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const resolved = resolveUserPath(archivePath);
  if (!(await fileExists(resolved))) {
    return { ok: false, error: `archive not found: ${resolved}` };
  }

  if (!resolveArchiveKind(resolved)) {
    return { ok: false, error: `unsupported archive: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

export async function packNpmSpecToArchive(params: {
  spec: string;
  timeoutMs: number;
  cwd: string;
}): Promise<
  | {
      ok: true;
      archivePath: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const res = await runCommandWithTimeout(["npm", "pack", params.spec, "--ignore-scripts"], {
    timeoutMs: Math.max(params.timeoutMs, 300_000),
    cwd: params.cwd,
    env: {
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    },
  });
  if (res.code !== 0) {
    return { ok: false, error: `npm pack failed: ${res.stderr.trim() || res.stdout.trim()}` };
  }

  const packed = (res.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!packed) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  return { ok: true, archivePath: path.join(params.cwd, packed) };
}
