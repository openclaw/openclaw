import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { fileExists, resolveArchiveKind } from "./archive.js";

export type NpmSpecResolution = {
  name?: string;
  version?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
};

export type NpmIntegrityDrift = {
  expectedIntegrity: string;
  actualIntegrity: string;
};

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

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseResolvedSpecFromId(id: string): string | undefined {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at >= id.length - 1) {
    return undefined;
  }
  const name = id.slice(0, at).trim();
  const version = id.slice(at + 1).trim();
  if (!name || !version) {
    return undefined;
  }
  return `${name}@${version}`;
}

function normalizeNpmPackEntry(
  entry: unknown,
): { filename?: string; metadata: NpmSpecResolution } | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  const name = toOptionalString(rec.name);
  const version = toOptionalString(rec.version);
  const id = toOptionalString(rec.id);
  const resolvedSpec =
    (name && version ? `${name}@${version}` : undefined) ??
    (id ? parseResolvedSpecFromId(id) : undefined);

  return {
    filename: toOptionalString(rec.filename),
    metadata: {
      name,
      version,
      resolvedSpec,
      integrity: toOptionalString(rec.integrity),
      shasum: toOptionalString(rec.shasum),
    },
  };
}

function parseNpmPackJsonOutput(
  raw: string,
): { filename?: string; metadata: NpmSpecResolution } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const arrayStart = trimmed.indexOf("[");
  if (arrayStart > 0) {
    candidates.push(trimmed.slice(arrayStart));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    let fallback: { filename?: string; metadata: NpmSpecResolution } | null = null;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const normalized = normalizeNpmPackEntry(entries[i]);
      if (!normalized) {
        continue;
      }
      if (!fallback) {
        fallback = normalized;
      }
      if (normalized.filename) {
        return normalized;
      }
    }
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

export async function packNpmSpecToArchive(params: {
  spec: string;
  timeoutMs: number;
  cwd: string;
}): Promise<
  | {
      ok: true;
      archivePath: string;
      metadata: NpmSpecResolution;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const res = await runCommandWithTimeout(
    ["npm", "pack", params.spec, "--ignore-scripts", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs, 300_000),
      cwd: params.cwd,
      env: {
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    },
  );
  if (res.code !== 0) {
    return { ok: false, error: `npm pack failed: ${res.stderr.trim() || res.stdout.trim()}` };
  }

  const parsedJson = parseNpmPackJsonOutput(res.stdout || "");

  const packed =
    parsedJson?.filename ??
    (res.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
  if (!packed) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  return {
    ok: true,
    archivePath: path.join(params.cwd, packed),
    metadata: parsedJson?.metadata ?? {},
  };
}
