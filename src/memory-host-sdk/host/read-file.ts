import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentContextLimits, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isFileMissingError, resolveContainedRegularFile } from "./fs-utils.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import {
  buildMemoryReadResult,
  DEFAULT_MEMORY_READ_LINES,
  type MemoryReadResult,
} from "./read-file-shared.js";

export async function readMemoryFile(params: {
  workspaceDir: string;
  extraPaths?: string[];
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines?: number;
  maxChars?: number;
}): Promise<MemoryReadResult> {
  const rawPath = params.relPath.trim();
  if (!rawPath) {
    throw new Error("path required");
  }
  const absPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(params.workspaceDir, rawPath);
  const relPath = path.relative(params.workspaceDir, absPath).replace(/\\/g, "/");
  const inWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
  const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
  const matchedAdditionalRoots: string[] = [];
  if (!allowedWorkspace && (params.extraPaths?.length ?? 0) > 0) {
    const additionalPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths);
    for (const additionalPath of additionalPaths) {
      try {
        const stat = await fs.lstat(additionalPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
            matchedAdditionalRoots.push(additionalPath);
            break;
          }
          continue;
        }
        if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
          matchedAdditionalRoots.push(additionalPath);
          break;
        }
      } catch {}
    }
  }
  const allowedAdditional = matchedAdditionalRoots.length > 0;
  if (!allowedWorkspace && !allowedAdditional) {
    throw new Error("path required");
  }
  if (!absPath.endsWith(".md")) {
    throw new Error("path required");
  }
  const statResult = await resolveContainedRegularFile({
    absPath,
    allowedRoots: allowedWorkspace ? [params.workspaceDir] : matchedAdditionalRoots,
  });
  if (statResult.missing) {
    return { text: "", path: relPath };
  }
  let content: string;
  try {
    content = await fs.readFile(statResult.realPath, "utf-8");
  } catch (err) {
    if (isFileMissingError(err)) {
      return { text: "", path: relPath };
    }
    throw err;
  }
  return buildMemoryReadResult({
    content,
    relPath,
    from: params.from,
    lines: params.lines,
    defaultLines: params.defaultLines ?? DEFAULT_MEMORY_READ_LINES,
    maxChars: params.maxChars,
    suggestReadFallback: allowedWorkspace,
  });
}

export async function readAgentMemoryFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<MemoryReadResult> {
  const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!settings) {
    throw new Error("memory search disabled");
  }
  const contextLimits = resolveAgentContextLimits(params.cfg, params.agentId);
  return await readMemoryFile({
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    extraPaths: settings.extraPaths,
    relPath: params.relPath,
    from: params.from,
    lines: params.lines,
    defaultLines: contextLimits?.memoryGetDefaultLines,
    maxChars: contextLimits?.memoryGetMaxChars,
  });
}
