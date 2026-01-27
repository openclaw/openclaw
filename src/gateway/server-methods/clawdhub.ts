/**
 * Gateway RPC handlers for ClawdHub marketplace integration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import JSZip from "jszip";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  downloadSkillZip,
  getSkillDetails,
  searchSkills,
  checkUpdates as checkClawdHubUpdates,
  type ClawdHubInstalledSkill as ClientInstalledSkill,
} from "../../clawdhub/client.js";
import { loadConfig } from "../../config/config.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateClawdHubCheckUpdatesParams,
  validateClawdHubDetailsParams,
  validateClawdHubInstallParams,
  validateClawdHubInstalledParams,
  validateClawdHubSearchParams,
  type ClawdHubInstallParams,
  type ClawdHubInstalledSkill,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ClawdHubLockFile = {
  version: number;
  skills: Record<string, ClawdHubInstalledSkill>;
};

function getLockFilePath(workspaceDir: string): string {
  return join(workspaceDir, ".clawdhub", "lock.json");
}

function readLockFile(workspaceDir: string): ClawdHubLockFile {
  const lockPath = getLockFilePath(workspaceDir);
  if (!existsSync(lockPath)) {
    return { version: 1, skills: {} };
  }
  try {
    const raw = readFileSync(lockPath, "utf-8");
    return JSON.parse(raw) as ClawdHubLockFile;
  } catch {
    return { version: 1, skills: {} };
  }
}

function writeLockFile(workspaceDir: string, lock: ClawdHubLockFile): void {
  const lockPath = getLockFilePath(workspaceDir);
  const lockDir = join(workspaceDir, ".clawdhub");
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
}

async function extractZipToSkillsDir(
  zipBuffer: ArrayBuffer,
  skillsDir: string,
  slug: string,
): Promise<string> {
  const targetDir = join(skillsDir, slug);

  // Create the target directory
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Convert ArrayBuffer to Buffer and load with JSZip
  const buffer = Buffer.from(zipBuffer);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    // Skip __MACOSX entries
    if (entry.name.startsWith("__MACOSX")) {
      continue;
    }

    const entryPath = entry.name.replaceAll("\\", "/");

    // Handle nested directories - strip the first directory component if it exists
    const parts = entryPath.split("/").filter(Boolean);
    let relativePath: string;
    if (parts.length > 1) {
      relativePath = parts.slice(1).join("/");
    } else {
      relativePath = parts.join("/");
    }

    if (!relativePath) continue;

    // Skip directory entries (they end with /)
    if (entry.dir || entryPath.endsWith("/")) {
      const dirPath = join(targetDir, relativePath);
      if (!dirPath.startsWith(targetDir)) {
        throw new Error(`zip entry escapes destination: ${entry.name}`);
      }
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
      continue;
    }

    const outPath = join(targetDir, relativePath);
    if (!outPath.startsWith(targetDir)) {
      throw new Error(`zip entry escapes destination: ${entry.name}`);
    }

    const outDir = dirname(outPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const content = await entry.async("nodebuffer");
    writeFileSync(outPath, content);
  }

  return targetDir;
}

export const clawdhubHandlers: GatewayRequestHandlers = {
  "clawdhub.search": async ({ params, respond }) => {
    if (!validateClawdHubSearchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawdhub.search params: ${formatValidationErrors(validateClawdHubSearchParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { query: string; limit?: number };

    try {
      const result = await searchSkills(p.query);
      // Apply limit if specified
      if (p.limit && result.results.length > p.limit) {
        result.results = result.results.slice(0, p.limit);
      }
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : "Search failed"),
      );
    }
  },

  "clawdhub.details": async ({ params, respond }) => {
    if (!validateClawdHubDetailsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawdhub.details params: ${formatValidationErrors(validateClawdHubDetailsParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { slug: string };

    try {
      const details = await getSkillDetails(p.slug);
      respond(true, details, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          err instanceof Error ? err.message : "Failed to fetch skill details",
        ),
      );
    }
  },

  "clawdhub.install": async ({ params, respond }) => {
    if (!validateClawdHubInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawdhub.install params: ${formatValidationErrors(validateClawdHubInstallParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as ClawdHubInstallParams;
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const skillsDir = join(workspaceDir, "skills");

    try {
      // Get skill details to resolve version
      const details = await getSkillDetails(p.slug);
      const version = p.version || details.currentVersion;

      // Check if already installed (unless force is true)
      const lock = readLockFile(workspaceDir);
      if (!p.force && lock.skills[p.slug]) {
        const installed = lock.skills[p.slug];
        if (installed.version === version) {
          respond(true, {
            ok: true,
            slug: p.slug,
            version,
            path: installed.path,
            message: `${p.slug}@${version} is already installed`,
          });
          return;
        }
      }

      // Download and extract
      const zipBuffer = await downloadSkillZip(p.slug, version);
      const installPath = await extractZipToSkillsDir(zipBuffer, skillsDir, p.slug);

      // Update lock file
      lock.skills[p.slug] = {
        slug: p.slug,
        version,
        installedAt: new Date().toISOString(),
        path: installPath,
        name: details.name,
        description: details.description,
        emoji: details.emoji,
      };
      writeLockFile(workspaceDir, lock);

      respond(true, {
        ok: true,
        slug: p.slug,
        version,
        path: installPath,
        message: `Installed ${details.name || p.slug}@${version}`,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          err instanceof Error ? err.message : "Installation failed",
        ),
      );
    }
  },

  "clawdhub.installed": ({ params, respond }) => {
    if (!validateClawdHubInstalledParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawdhub.installed params: ${formatValidationErrors(validateClawdHubInstalledParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const lock = readLockFile(workspaceDir);

    const skills: ClawdHubInstalledSkill[] = Object.values(lock.skills);
    respond(true, { skills }, undefined);
  },

  "clawdhub.checkUpdates": async ({ params, respond }) => {
    if (!validateClawdHubCheckUpdatesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawdhub.checkUpdates params: ${formatValidationErrors(validateClawdHubCheckUpdatesParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const lock = readLockFile(workspaceDir);

    const installedSkills: ClientInstalledSkill[] = Object.values(lock.skills).map((s) => ({
      slug: s.slug,
      version: s.version,
      installedAt: s.installedAt,
      path: s.path,
    }));

    try {
      const updates = await checkClawdHubUpdates(installedSkills);
      respond(true, { updates }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          err instanceof Error ? err.message : "Update check failed",
        ),
      );
    }
  },
};
