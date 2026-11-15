import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import { extractErrorCode } from "../../infra/errors.js";
const DREAM_DIARY_FILE_NAMES = ["DREAMS.md", "dreams.md"] as const;

export type DoctorMemoryDreamDiaryPayload = {
  agentId: string;
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
};

function getWorkspaceMemoryMaintenance(workspaceDir: string) {
  const access = getAgentWorkspaceAccess(workspaceDir, "memoryFiles");
  if (!access?.memoryFiles) {
    return undefined;
  }
  const files = access.memoryFiles.maintenance;
  if (!files) {
    throw new WorkspaceAccessUnavailableError("Remote Memory maintenance is unavailable");
  }
  return files;
}

export async function listWorkspaceDailyFiles(workspaceDir: string): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  const files = getWorkspaceMemoryMaintenance(workspaceDir);
  let entries: string[];
  try {
    entries = files
      ? (await files.listDirectory(memoryDir)).map((entry) => entry.name)
      : await fs.readdir(memoryDir);
  } catch (err) {
    if (extractErrorCode(err) === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/i.test(name))
    .map((name) => path.join(memoryDir, name))
    .toSorted((left, right) => left.localeCompare(right));
}

export async function readDreamDiary(
  workspaceDir: string,
): Promise<Omit<DoctorMemoryDreamDiaryPayload, "agentId">> {
  const files = getWorkspaceMemoryMaintenance(workspaceDir);
  for (const name of DREAM_DIARY_FILE_NAMES) {
    const filePath = path.join(workspaceDir, name);
    let stat;
    try {
      if (files) {
        stat = await files.stat(filePath, false);
      } else {
        const localStat = await fs.lstat(filePath);
        stat = {
          isSymbolicLink: localStat.isSymbolicLink(),
          isFile: localStat.isFile(),
          mtimeMs: localStat.mtimeMs,
        };
      }
    } catch (err) {
      const code = extractErrorCode(err);
      if (code === "ENOENT") {
        continue;
      }
      return {
        found: false,
        path: name,
      };
    }
    if (stat.isSymbolicLink || !stat.isFile) {
      // Ignore redirected diaries; doctor actions only operate on real workspace files.
      continue;
    }
    try {
      const content = files
        ? (await files.readFile(filePath)).toString("utf-8")
        : await fs.readFile(filePath, "utf-8");
      return {
        found: true,
        path: name,
        content,
        updatedAtMs: Math.floor(stat.mtimeMs),
      };
    } catch {
      return {
        found: false,
        path: name,
      };
    }
  }
  return {
    found: false,
    path: DREAM_DIARY_FILE_NAMES[0],
  };
}
