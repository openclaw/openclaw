import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENTS_FILENAME,
  filterBootstrapFilesForSession,
  type WorkspaceBootstrapFile,
} from "../../../agents/workspace.js";
import { loadWorkspaceSkillEntries } from "../../../agents/skills/workspace.js";
import type { ParsedSkillFrontmatter, SkillEntry } from "../../../agents/skills/types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "skills-preload";
const log = createSubsystemLogger("skills-preload");

/**
 * Resolve the `preload` flag for a skill entry, accepting either:
 *   1. Top-level YAML frontmatter: `preload: true` (most ergonomic for authors)
 *   2. The OpenClaw metadata block: `metadata.openclaw.preload: true`
 *
 * The flat `frontmatter` dict stores YAML scalars as strings, so the boolean
 * `true` arrives here as the string "true".
 */
function resolveSkillPreloadFlag(entry: SkillEntry): boolean {
  if (entry.metadata?.preload === true) {
    return true;
  }
  const fromFlat = (entry.frontmatter as ParsedSkillFrontmatter | undefined)?.preload;
  if (typeof fromFlat === "string" && fromFlat.trim().toLowerCase() === "true") {
    return true;
  }
  return false;
}

/**
 * Resolve the list of sibling files to preload alongside SKILL.md.
 * Accepts either `preload-files` or `preloadFiles`, and either:
 *   - A YAML list (which the flat parser stores as a JSON-stringified array)
 *   - A JSON5 array inside `metadata.openclaw.preloadFiles`
 *   - A comma-separated string fallback
 */
function resolveSkillPreloadFiles(entry: SkillEntry): string[] {
  // Prefer the OpenClaw metadata block if present.
  const metadataList = entry.metadata?.preloadFiles;
  if (Array.isArray(metadataList) && metadataList.length > 0) {
    return metadataList.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  // Fall back to flat frontmatter (YAML lists serialized as JSON strings).
  const frontmatter = entry.frontmatter as ParsedSkillFrontmatter | undefined;
  const raw = frontmatter?.["preload-files"] ?? frontmatter?.preloadFiles;
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  // Try JSON parse first (matches what `coerceYamlFrontmatterValue` produces for arrays).
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
      }
    } catch {
      // fall through to comma-split
    }
  }
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// Conservative per-skill cap to keep system prompts bounded.
// Individual files larger than this are skipped with a warning.
const MAX_PRELOAD_FILE_BYTES = 64 * 1024;
// Aggregate cap across all preloaded skills for a single bootstrap call.
const MAX_TOTAL_PRELOAD_BYTES = 256 * 1024;

function safeRead(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return undefined;
    }
    if (stat.size > MAX_PRELOAD_FILE_BYTES) {
      log.warn("skipping oversized preload file", {
        filePath,
        size: stat.size,
        maxBytes: MAX_PRELOAD_FILE_BYTES,
      });
      return undefined;
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    log.debug("preload file read failed", { filePath, error: String(err) });
    return undefined;
  }
}

const skillsPreloadHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  // Hook is enabled by default — only an explicit `enabled: false` disables it.
  if (hookConfig?.enabled === false) {
    return;
  }

  let skillEntries;
  try {
    skillEntries = loadWorkspaceSkillEntries(context.workspaceDir, {
      config: context.cfg,
    });
  } catch (err) {
    log.warn(`failed to load skill entries: ${String(err)}`);
    return;
  }

  const preloaded: WorkspaceBootstrapFile[] = [];
  let totalBytes = 0;

  for (const entry of skillEntries) {
    if (!resolveSkillPreloadFlag(entry)) {
      continue;
    }
    // pi-coding-agent's Skill type uses `filePath` (the SKILL.md path) and
    // `baseDir` (the skill's containing directory). See node_modules/.../core/skills.d.ts.
    const skillPath = entry.skill?.filePath;
    const skillDirRaw = entry.skill?.baseDir;
    if (typeof skillPath !== "string" || !skillPath) {
      continue;
    }
    const skillDir =
      typeof skillDirRaw === "string" && skillDirRaw ? skillDirRaw : path.dirname(skillPath);

    // Always preload SKILL.md itself when preload=true.
    const skillMdContent = safeRead(skillPath);
    if (skillMdContent !== undefined) {
      const bytes = Buffer.byteLength(skillMdContent, "utf-8");
      if (totalBytes + bytes > MAX_TOTAL_PRELOAD_BYTES) {
        log.warn("skills-preload total budget exceeded; truncating", {
          skill: entry.skill?.name,
          totalBytes,
          maxBytes: MAX_TOTAL_PRELOAD_BYTES,
        });
        break;
      }
      totalBytes += bytes;
      preloaded.push({
        // Use AGENTS.md so the entry survives subagent bootstrap filtering
        // (filterBootstrapFilesForSession only keeps allowlisted names for subagents).
        // The actual file path is preserved in `path` and rendered in the prompt header.
        name: DEFAULT_AGENTS_FILENAME,
        path: skillPath,
        content: skillMdContent,
        missing: false,
      });
    }

    // Preload any explicitly listed sibling files.
    const preloadFiles = resolveSkillPreloadFiles(entry);
    for (const rel of preloadFiles) {
      if (typeof rel !== "string" || !rel) {
        continue;
      }
      // Disallow path traversal outside the skill directory.
      const relNormalized = path.normalize(rel);
      if (relNormalized.startsWith("..") || path.isAbsolute(relNormalized)) {
        log.warn("rejecting preload file path traversal", {
          skill: entry.skill?.name,
          rel,
        });
        continue;
      }
      const fullPath = path.join(skillDir, relNormalized);
      // Final containment check (handles symlinks/edge cases).
      const resolved = path.resolve(fullPath);
      const skillDirResolved = path.resolve(skillDir);
      if (
        resolved !== skillDirResolved &&
        !resolved.startsWith(skillDirResolved + path.sep)
      ) {
        log.warn("rejecting preload file outside skill dir", {
          skill: entry.skill?.name,
          rel,
        });
        continue;
      }
      const content = safeRead(resolved);
      if (content === undefined) {
        continue;
      }
      const bytes = Buffer.byteLength(content, "utf-8");
      if (totalBytes + bytes > MAX_TOTAL_PRELOAD_BYTES) {
        log.warn("skills-preload total budget exceeded; truncating", {
          skill: entry.skill?.name,
          totalBytes,
          maxBytes: MAX_TOTAL_PRELOAD_BYTES,
        });
        break;
      }
      totalBytes += bytes;
      preloaded.push({
        name: DEFAULT_AGENTS_FILENAME,
        path: resolved,
        content,
        missing: false,
      });
    }
  }

  if (preloaded.length === 0) {
    return;
  }

  log.debug("preloaded skill content into bootstrap context", {
    fileCount: preloaded.length,
    totalBytes,
  });

  context.bootstrapFiles = filterBootstrapFilesForSession(
    [...context.bootstrapFiles, ...preloaded],
    context.sessionKey,
  );
};

export default skillsPreloadHook;
