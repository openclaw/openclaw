/**
 * Public SDK facade for memory host runtime core and public artifact discovery.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { assertNoSymlinkParents } from "../infra/fs-safe-advanced.js";
import type { MemoryPluginPublicArtifact } from "../plugins/memory-state.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./memory-core-host-runtime-core.js";
import { resolveMemoryHostEventLogPath } from "./memory-host-events.js";

export * from "./memory-core-host-runtime-core.js";

async function isRegularFileWithinWorkspace(
  workspaceRoot: string,
  filePath: string,
): Promise<boolean> {
  try {
    await assertNoSymlinkParents({ rootDir: workspaceRoot, targetPath: filePath });
    return (await fs.lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function resolveArtifactAgentIds(
  relativePath: string,
  workspaceAgentIds: string[],
): string[] | null {
  const match = /^memory\/\.dreams\/agents\/([^/]+)\//.exec(relativePath);
  if (!match?.[1]) {
    if (relativePath.startsWith("memory/.dreams/")) {
      // Private artifacts without a recognized owner must not cross an agent boundary.
      return null;
    }
    if (relativePath.startsWith("memory/dreaming/") && workspaceAgentIds.length > 1) {
      // Legacy dream reports predate agent ownership metadata. A shared
      // workspace cannot safely attribute them, so keep them private.
      return null;
    }
    return workspaceAgentIds;
  }
  return workspaceAgentIds.includes(match[1]) ? [match[1]] : null;
}

function resolveMemoryArtifactKind(relativePath: string): "daily-note" | "dream-report" {
  return relativePath.startsWith("memory/dreaming/") ||
    relativePath.startsWith("memory/.dreams/agents/")
    ? "dream-report"
    : "daily-note";
}

async function resolveMemoryArtifactWorkspaces(cfg: OpenClawConfig): Promise<
  Array<{
    workspaceDir: string;
    agentIds: string[];
  }>
> {
  const byWorkspace = new Map<string, { workspaceDir: string; agentIds: string[] }>();
  for (const rawAgentId of listAgentIds(cfg)) {
    const agentId = normalizeAgentId(rawAgentId);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const workspaceRoot = await fs.realpath(workspaceDir).catch(() => path.resolve(workspaceDir));
    const existing = byWorkspace.get(workspaceRoot);
    if (existing) {
      existing.agentIds.push(agentId);
      continue;
    }
    byWorkspace.set(workspaceRoot, { workspaceDir: workspaceRoot, agentIds: [agentId] });
  }
  return [...byWorkspace.values()];
}

/** Lists public memory artifacts for one workspace, including notes and event logs. */
export async function listMemoryWorkspacePublicArtifacts(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts: MemoryPluginPublicArtifact[] = [];
  const workspaceRoot = await fs
    .realpath(params.workspaceDir)
    .catch(() => path.resolve(params.workspaceDir));
  const workspaceEntries = new Set(
    (await fs.readdir(workspaceRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  if (workspaceEntries.has("MEMORY.md")) {
    const absolutePath = path.join(workspaceRoot, "MEMORY.md");
    artifacts.push({
      kind: "memory-root",
      workspaceDir: workspaceRoot,
      relativePath: "MEMORY.md",
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const memoryDir = path.join(workspaceRoot, "memory");
  const memoryDirStat = await fs.lstat(memoryDir).catch(() => undefined);
  if (memoryDirStat?.isDirectory()) {
    for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
      const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
      const agentIds = resolveArtifactAgentIds(relativePath, params.agentIds);
      if (!agentIds) {
        continue;
      }
      artifacts.push({
        kind: resolveMemoryArtifactKind(relativePath),
        workspaceDir: workspaceRoot,
        relativePath,
        absolutePath,
        agentIds,
        contentType: "markdown",
      });
    }

    for (const agentId of params.agentIds) {
      const eventLogPath = resolveMemoryHostEventLogPath(workspaceRoot, agentId);
      if (!(await isRegularFileWithinWorkspace(workspaceRoot, eventLogPath))) {
        continue;
      }
      artifacts.push({
        kind: "event-log",
        workspaceDir: workspaceRoot,
        relativePath: path.relative(workspaceRoot, eventLogPath).replace(/\\/g, "/"),
        absolutePath: eventLogPath,
        agentIds: [agentId],
        contentType: "json",
      });
    }
    // The legacy journal has no owner. Do not expose it from a shared workspace:
    // it may contain recall queries from every agent that used that workspace.
    if (params.agentIds.length === 1) {
      const eventLogPath = resolveMemoryHostEventLogPath(workspaceRoot);
      if (await isRegularFileWithinWorkspace(workspaceRoot, eventLogPath)) {
        artifacts.push({
          kind: "event-log",
          workspaceDir: workspaceRoot,
          relativePath: path.relative(workspaceRoot, eventLogPath).replace(/\\/g, "/"),
          absolutePath: eventLogPath,
          agentIds: [...params.agentIds],
          contentType: "json",
        });
      }
    }
  }

  const deduped = new Map<string, MemoryPluginPublicArtifact>();
  for (const artifact of artifacts) {
    deduped.set(`${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`, artifact);
  }
  return [...deduped.values()];
}

/** Lists public memory artifacts across all configured memory workspaces. */
export async function listMemoryHostPublicArtifacts(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<MemoryPluginPublicArtifact[]> {
  const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const workspaces = await resolveMemoryArtifactWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    artifacts.push(
      ...(await listMemoryWorkspacePublicArtifacts({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  return requestedAgentId
    ? artifacts.filter((artifact) => artifact.agentIds.includes(requestedAgentId))
    : artifacts;
}
