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
import type { Skill } from "./skill-contract.js";
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

export function loadSingleSkillDirectory(params: {
  skillDir: string;
  source: string;
  rootRealPath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): LoadedLocalSkill | null {
  const skillFilePath = path.join(params.skillDir, "SKILL.md");
  const { rootRealPath, maxBytes, rejectHardlinks, onDiagnostic } = params;
  const opened = openRootFileSync({
    absolutePath: skillFilePath,
    rootPath: rootRealPath,
    rootRealPath,
    boundaryLabel: "skill root",
    // Operator skill roots are commonly symlinked; fs-safe still rejects hops
    // whose canonical target escapes the skill root.
    rejectSymlinks: false,
    rejectHardlinks: rejectHardlinks !== false,
  });
  if (!opened.ok) {
    if (!isRootFileMissingFailure(opened)) {
      const message =
        opened.error instanceof Error
          ? opened.error.message
          : `failed to open skill file (${opened.reason})`;
      onDiagnostic?.({
        kind: opened.reason === "validation" ? "invalid" : "read",
        path: skillFilePath,
        message,
      });
    }
    return null;
  }
  let raw: string;
  try {
    raw =
      maxBytes === undefined
        ? fs.readFileSync(opened.fd, "utf8")
        : readFileDescriptorBoundedSync(opened.fd, maxBytes).toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read skill file";
    onDiagnostic?.({
      kind: error instanceof RangeError ? "invalid" : "read",
      path: skillFilePath,
      message,
    });
    return null;
  } finally {
    fs.closeSync(opened.fd);
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
      source: params.source,
      sourceInfo: { ...loaded.skill.sourceInfo, path: filePath, baseDir, source: params.source },
    },
    frontmatter: { ...loaded.frontmatter },
    content: raw,
  };
}
