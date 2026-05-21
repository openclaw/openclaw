import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { pathExists } from "../infra/fs-safe.js";
import { resolveMemoryDreamingWorkspaces } from "../memory-host-sdk/dreaming.js";
import { resolveMemoryHostEventLogPath } from "../memory-host-sdk/events.js";
import type { MemoryPluginPublicArtifact } from "./memory-state.js";

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
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

async function collectWorkspaceArtifacts(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts: MemoryPluginPublicArtifact[] = [];
  const workspaceEntries = new Set(
    (await fs.readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  for (const relativePath of ["MEMORY.md"]) {
    if (!workspaceEntries.has(relativePath)) {
      continue;
    }
    const absolutePath = path.join(params.workspaceDir, relativePath);
    artifacts.push({
      kind: "memory-root",
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const memoryDir = path.join(params.workspaceDir, "memory");
  for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
    const relativePath = path.relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
    artifacts.push({
      kind: relativePath.startsWith("memory/dreaming/") ? "dream-report" : "daily-note",
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir);
  if (await pathExists(eventLogPath)) {
    artifacts.push({
      kind: "event-log",
      workspaceDir: params.workspaceDir,
      relativePath: path.relative(params.workspaceDir, eventLogPath).replace(/\\/g, "/"),
      absolutePath: eventLogPath,
      agentIds: [...params.agentIds],
      contentType: "json",
    });
  }

  const deduped = new Map<string, MemoryPluginPublicArtifact>();
  for (const artifact of artifacts) {
    deduped.set(`${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`, artifact);
  }
  return [...deduped.values()];
}

export async function listMemoryWorkspacePublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    artifacts.push(
      ...(await collectWorkspaceArtifacts({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  return artifacts;
}

export function listMemoryWorkspaceAgentIds(params: { cfg: OpenClawConfig }): string[] {
  const agentIds: string[] = [];
  const seen = new Set<string>();
  for (const workspace of resolveMemoryDreamingWorkspaces(params.cfg)) {
    for (const agentId of workspace.agentIds) {
      if (seen.has(agentId)) {
        continue;
      }
      seen.add(agentId);
      agentIds.push(agentId);
    }
  }
  return agentIds;
}
