import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";

export async function readMemoryFile(params: {
  workspaceDir: string;
  extraPaths?: string[];
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<{ text: string; path: string }> {
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
  let allowedAdditional = false;
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
            allowedAdditional = true;
            break;
          }
          continue;
        }
        if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
          allowedAdditional = true;
          break;
        }
      } catch {}
    }
  }
  if (!allowedWorkspace && !allowedAdditional) {
    throw new Error("path required");
  }
  if (!absPath.endsWith(".md")) {
    throw new Error("path required");
  }
  const statResult = await statRegularFile(absPath);
  if (statResult.missing) {
    return { text: "", path: relPath };
  }
  if (!params.from && !params.lines) {
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      if (isFileMissingError(err)) {
        return { text: "", path: relPath };
      }
      throw err;
    }
    return { text: content, path: relPath };
  }

  const start = Math.max(1, params.from ?? 1);
  const count = Math.max(1, params.lines ?? Number.MAX_SAFE_INTEGER);
  const end = start + count - 1;
  const collected: string[] = [];
  let lineNo = 0;
  const stream = createReadStream(absPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < start) {
        continue;
      }
      if (lineNo > end) {
        break;
      }
      collected.push(line);
    }
  } catch (err) {
    if (isFileMissingError(err)) {
      return { text: "", path: relPath };
    }
    throw err;
  } finally {
    rl.close();
    stream.destroy();
  }
  return { text: collected.join("\n"), path: relPath };
}

export async function readAgentMemoryFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<{ text: string; path: string }> {
  const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!settings) {
    throw new Error("memory search disabled");
  }
  return await readMemoryFile({
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    extraPaths: settings.extraPaths,
    relPath: params.relPath,
    from: params.from,
    lines: params.lines,
  });
}
