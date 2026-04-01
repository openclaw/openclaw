// AGENT_BOT_COMPAT: install a skill-registry artifact (base install-ticket downloadUrl) into an agent workspace.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extractArchive } from "../agents/skills-install-extract.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isWithinDir } from "../infra/path-safety.js";
import { ensureDir } from "../utils.js";

const SAFE_SKILL_KEY = /^[a-z0-9][a-z0-9-_]*$/;

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => {
      hash.update(chunk as Buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveArchiveTypeAndSuffix(params: {
  artifactFormat?: string;
  downloadUrl: string;
}): { archiveType: "zip" | "tar.gz"; suffix: string } | undefined {
  const fmt = params.artifactFormat?.trim().toLowerCase();
  if (fmt === "zip") {
    return { archiveType: "zip", suffix: ".zip" };
  }
  if (fmt === "tar_gz" || fmt === "tar.gz" || fmt === "tgz") {
    return { archiveType: "tar.gz", suffix: ".tar.gz" };
  }
  try {
    const p = new URL(params.downloadUrl).pathname.toLowerCase();
    if (p.endsWith(".zip")) {
      return { archiveType: "zip", suffix: ".zip" };
    }
    if (p.endsWith(".tar.gz") || p.endsWith(".tgz")) {
      return { archiveType: "tar.gz", suffix: ".tar.gz" };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * When the registry archive uses `single-folder` layout (`my-skill/SKILL.md`), extraction leaves
 * `skills/<skillKey>/my-skill/SKILL.md`. Promote inner files to `skills/<skillKey>/` when safe.
 */
async function promoteSingleFolderSkillLayout(skillRoot: string): Promise<void> {
  const rootSkillMd = path.join(skillRoot, "SKILL.md");
  if (await fileExists(rootSkillMd)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(skillRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const files = entries.filter((e) => e.isFile());
  if (dirs.length !== 1 || files.length > 0) {
    return;
  }
  const inner = path.join(skillRoot, dirs[0].name);
  if (!(await fileExists(path.join(inner, "SKILL.md")))) {
    return;
  }
  for (const ent of await fs.promises.readdir(inner, { withFileTypes: true })) {
    await fs.promises.rename(path.join(inner, ent.name), path.join(skillRoot, ent.name));
  }
  await fs.promises.rm(inner, { recursive: true, force: true });
}

export type ControlPlaneRegistryInstallOk = {
  ok: true;
  skillKey: string;
  installedPath: string;
  bytes: number;
  sha256?: string;
};

export type ControlPlaneRegistryInstallErr = {
  ok: false;
  message: string;
};

export type ControlPlaneRegistryInstallResult =
  | ControlPlaneRegistryInstallOk
  | ControlPlaneRegistryInstallErr;

export async function installSkillPackageFromRegistryDownload(params: {
  workspaceDir: string;
  downloadUrl: string;
  skillKey: string;
  artifactFormat?: string;
  expectedSha256?: string;
  stripComponents?: number;
  timeoutMs?: number;
}): Promise<ControlPlaneRegistryInstallResult> {
  const skillKey = params.skillKey.trim();
  if (!SAFE_SKILL_KEY.test(skillKey)) {
    return { ok: false, message: "invalid skillKey" };
  }

  const workspaceResolved = path.resolve(params.workspaceDir);
  const skillsRoot = path.join(workspaceResolved, "skills");
  const skillRoot = path.join(skillsRoot, skillKey);

  if (!isWithinDir(workspaceResolved, skillRoot)) {
    return { ok: false, message: "refusing skill install path outside workspace" };
  }

  const resolved = resolveArchiveTypeAndSuffix({
    artifactFormat: params.artifactFormat,
    downloadUrl: params.downloadUrl.trim(),
  });
  if (!resolved) {
    return {
      ok: false,
      message: "could not determine archive type; pass artifactFormat zip or tar_gz",
    };
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : 120_000;

  const strip =
    typeof params.stripComponents === "number" && Number.isFinite(params.stripComponents)
      ? Math.max(0, Math.floor(params.stripComponents))
      : 0;

  const tempPath = path.join(skillsRoot, `.registry-staging-${randomUUID()}${resolved.suffix}`);

  try {
    await ensureDir(skillsRoot);
    const { response, release } = await fetchWithSsrFGuard({
      url: params.downloadUrl.trim(),
      timeoutMs,
      auditContext: "control-plane-skill-registry-install",
    });
    try {
      if (!response.ok || !response.body) {
        return {
          ok: false,
          message: `download failed (${response.status} ${response.statusText})`,
        };
      }
      const body = response.body as unknown;
      const readable = isNodeReadableStream(body)
        ? body
        : Readable.fromWeb(body as NodeReadableStream);
      const file = fs.createWriteStream(tempPath);
      await pipeline(readable, file);
    } finally {
      await release();
    }

    const bytes = (await fs.promises.stat(tempPath)).size;
    const sha256 = await hashFileSha256(tempPath);
    const expected = params.expectedSha256?.trim().toLowerCase();
    if (expected && sha256 !== expected) {
      return { ok: false, message: "sha256 mismatch for downloaded artifact" };
    }

    await fs.promises.rm(skillRoot, { recursive: true, force: true });
    await ensureDir(skillRoot);

    const extractResult = await extractArchive({
      archivePath: tempPath,
      archiveType: resolved.archiveType,
      targetDir: skillRoot,
      stripComponents: strip,
      timeoutMs,
    });
    if (extractResult.code !== 0) {
      const detail = [extractResult.stderr, extractResult.stdout].filter(Boolean).join("\n").trim();
      return {
        ok: false,
        message: detail || "archive extraction failed",
      };
    }

    await promoteSingleFolderSkillLayout(skillRoot);

    if (!(await fileExists(path.join(skillRoot, "SKILL.md")))) {
      return {
        ok: false,
        message:
          "installed archive does not contain SKILL.md at skill root (after layout normalize)",
      };
    }

    return {
      ok: true,
      skillKey,
      installedPath: skillRoot,
      bytes,
      sha256,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
