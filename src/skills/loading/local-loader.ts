// Local skill loader reads skill definitions from local filesystem roots.
import fs from "node:fs";
import path from "node:path";
import {
  isRootFileMissingFailure,
  openRootFileSync,
  readFileDescriptorBoundedSync,
} from "../../infra/boundary-file-read.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { ParsedSkillFrontmatter } from "../types.js";
import { parseSkillFrontmatter } from "./frontmatter.js";
import type { Skill, SkillSourceRootIdentity } from "./skill-contract.js";
import { materializeSkill } from "./skill-materializer.js";

export type LoadedLocalSkill = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  content: string;
};

// Reuse parsing and hashing across checked-out copies, after each boundary-safe read.
// Bound retained instruction text to 8 MiB plus parsed facts; large skills bypass reuse.
const MAX_CACHED_SKILL_CONTENT_CHARS = 16 * 1024;
const MAX_CACHED_SKILL_CONTENTS = 256;
const localSkillContentCache = new Map<string, Omit<LoadedLocalSkill, "content">>();

export type LocalSkillLoadDiagnostic = {
  kind: "read" | "invalid";
  path: string;
  message: string;
};

function captureExactSkillRootIdentity(rootRealPath: string): SkillSourceRootIdentity | undefined {
  try {
    const stat = fs.statSync(rootRealPath, { bigint: true });
    if (!stat.isDirectory() || stat.dev === 0n || stat.ino === 0n) {
      return undefined;
    }
    return {
      realPath: path.resolve(rootRealPath),
      dev: stat.dev.toString(10),
      ino: stat.ino.toString(10),
    };
  } catch {
    return undefined;
  }
}

function sameSkillRootIdentity(
  left: SkillSourceRootIdentity | undefined,
  right: SkillSourceRootIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.realPath === right.realPath &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

// Read SKILL.md through the root boundary helper so symlinks cannot escape the skill root.
function readSkillFileSync(params: {
  rootRealPath: string;
  filePath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): string | null {
  const opened = openRootFileSync({
    absolutePath: params.filePath,
    rootPath: params.rootRealPath,
    rootRealPath: params.rootRealPath,
    boundaryLabel: "skill root",
    // Operator skill roots are commonly symlinked; fs-safe still rejects hops
    // whose canonical target escapes the skill root.
    rejectSymlinks: false,
    rejectHardlinks: params.rejectHardlinks !== false,
  });
  if (!opened.ok) {
    if (!isRootFileMissingFailure(opened)) {
      const message =
        opened.error instanceof Error
          ? opened.error.message
          : `failed to open skill file (${opened.reason})`;
      params.onDiagnostic?.({
        kind: opened.reason === "validation" ? "invalid" : "read",
        path: params.filePath,
        message,
      });
    }
    return null;
  }
  try {
    return params.maxBytes === undefined
      ? fs.readFileSync(opened.fd, "utf8")
      : readFileDescriptorBoundedSync(opened.fd, params.maxBytes).toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read skill file";
    params.onDiagnostic?.({
      kind: error instanceof RangeError ? "invalid" : "read",
      path: params.filePath,
      message,
    });
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function loadSingleSkillDirectory(params: {
  skillDir: string;
  source: string;
  rootRealPath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): LoadedLocalSkill | null {
  const skillFilePath = path.join(params.skillDir, "SKILL.md");
  const sourceRootIdentity = captureExactSkillRootIdentity(params.rootRealPath);
  const raw = readSkillFileSync({
    rootRealPath: params.rootRealPath,
    filePath: skillFilePath,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    onDiagnostic: params.onDiagnostic,
  });
  if (raw === null) {
    return null;
  }
  const sourceRootIdentityAfterRead = captureExactSkillRootIdentity(params.rootRealPath);
  if (
    sourceRootIdentity !== undefined &&
    !sameSkillRootIdentity(sourceRootIdentity, sourceRootIdentityAfterRead)
  ) {
    params.onDiagnostic?.({
      kind: "invalid",
      path: skillFilePath,
      message: "skill root identity changed while reading SKILL.md",
    });
    return null;
  }

  const fallbackName = path.basename(params.skillDir).trim();
  const filePath = path.resolve(skillFilePath);
  const baseDir = path.resolve(params.skillDir);
  let loaded = localSkillContentCache.get(raw);
  // An omitted name is directory-derived, including its fallback display title.
  if (loaded && !loaded.frontmatter.name?.trim() && loaded.skill.name !== fallbackName) {
    loaded = undefined;
  }
  if (!loaded) {
    let frontmatter: ParsedSkillFrontmatter;
    try {
      frontmatter = parseSkillFrontmatter(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to parse skill frontmatter";
      params.onDiagnostic?.({ kind: "invalid", path: skillFilePath, message });
      return null;
    }
    const name = frontmatter.name?.trim() || fallbackName;
    const description = frontmatter.description?.trim();
    if (!name || !description) {
      params.onDiagnostic?.({
        kind: "invalid",
        path: skillFilePath,
        message: !name ? "name is required" : "description is required",
      });
      return null;
    }
    loaded = {
      skill: materializeSkill({
        content: raw,
        frontmatter,
        name,
        description,
        filePath,
        baseDir,
        source: params.source,
        sourceOptions: { source: params.source, scope: "project", origin: "top-level" },
      }),
      frontmatter,
    };
  }
  if (raw.length <= MAX_CACHED_SKILL_CONTENT_CHARS) {
    localSkillContentCache.delete(raw);
    localSkillContentCache.set(raw, loaded);
    pruneMapToMaxSize(localSkillContentCache, MAX_CACHED_SKILL_CONTENTS);
  }

  return {
    skill: {
      ...loaded.skill,
      filePath,
      baseDir,
      ...(sourceRootIdentity ? { sourceRootIdentity } : {}),
      source: params.source,
      sourceInfo: { ...loaded.skill.sourceInfo, path: filePath, baseDir, source: params.source },
    },
    frontmatter: { ...loaded.frontmatter },
    content: raw,
  };
}

export function readSkillFrontmatterSafe(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
}): Record<string, string> | null {
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(path.resolve(params.rootDir));
  } catch {
    return null;
  }
  const raw = readSkillFileSync({
    rootRealPath,
    filePath: path.resolve(params.filePath),
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (raw === null) {
    return null;
  }
  try {
    return parseSkillFrontmatter(raw);
  } catch {
    return null;
  }
}
