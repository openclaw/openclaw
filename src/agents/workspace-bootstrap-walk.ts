import fs from "node:fs/promises";
import path from "node:path";
import type { Minimatch } from "minimatch";
import { isPathInside } from "../infra/path-guards.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";
import { normalizeWorkspacePatternPath } from "./workspace-bootstrap-policy.js";

export async function* walkWorkspaceFiles(
  workspaceDir: string,
  initialRelativeDir: string,
  matcher: Minimatch,
): AsyncGenerator<string> {
  const access = getAgentWorkspaceAccess(workspaceDir);
  const stack = [initialRelativeDir === "." ? "" : initialRelativeDir];
  while (stack.length > 0) {
    const currentRelativeDir = stack.pop() ?? "";
    const currentDir = path.resolve(workspaceDir, currentRelativeDir);
    if (!isPathInside(workspaceDir, currentDir)) {
      continue;
    }

    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      if (access) {
        if (!access.bridge.readDirectory) {
          throw new Error("Workspace bootstrap directory listing is unavailable");
        }
        const remoteEntries = await access.bridge.readDirectory({
          filePath: currentRelativeDir || ".",
        });
        if (getAgentWorkspaceAccess(workspaceDir) !== access) {
          throw new Error("Workspace access changed while discovering bootstrap files");
        }
        entries = remoteEntries.map(({ name, isDirectory }) => ({
          name,
          isDirectory,
          isFile: !isDirectory,
        }));
      } else {
        entries = (await fs.readdir(currentDir, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile() || entry.isSymbolicLink(),
        }));
      }
    } catch (error) {
      if (access) {
        throw error;
      }
      continue;
    }

    for (const entry of entries) {
      const childRelativePath = currentRelativeDir
        ? path.join(currentRelativeDir, entry.name)
        : entry.name;
      const normalizedChildPath = normalizeWorkspacePatternPath(childRelativePath);
      if (entry.isDirectory) {
        if (matcher.match(normalizedChildPath, true)) {
          stack.push(childRelativePath);
        }
        continue;
      }
      if (entry.isFile && matcher.match(normalizedChildPath)) {
        yield normalizedChildPath;
      }
    }
  }
}
