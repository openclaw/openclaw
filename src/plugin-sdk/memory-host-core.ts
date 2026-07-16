/**
 * Public SDK facade for memory host runtime core and public artifact discovery.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  listStoredMemoryHostEvents,
  memoryHostWorkspacePrefix,
} from "../memory-host-sdk/event-store.js";
import type { MemoryPluginPublicArtifact } from "../plugins/memory-state.js";
import { resolveMemoryDreamingWorkspaces } from "./memory-core-host-status.js";

const MEMORY_HOST_EVENTS_RELATIVE_PATH = "memory/events/memory-host-events.json";

export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
} from "../plugins/memory-state.js";
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPromptSectionBuilder,
} from "../plugins/memory-state.js";
export { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
export { resolveSessionAgentId } from "../agents/agent-scope.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";

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

/** Lists public memory artifacts for one workspace, including notes and event logs. */
async function listMemoryWorkspacePublicArtifacts(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts: MemoryPluginPublicArtifact[] = [];
  const workspaceEntries = new Set(
    (await fs.readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  if (workspaceEntries.has("MEMORY.md")) {
    const absolutePath = path.join(params.workspaceDir, "MEMORY.md");
    artifacts.push({
      kind: "memory-root",
      workspaceDir: params.workspaceDir,
      relativePath: "MEMORY.md",
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

  const storedEvents = listStoredMemoryHostEvents({ workspaceDir: params.workspaceDir });
  if (storedEvents.length > 0) {
    const events = storedEvents.map((entry) => entry.value.event);
    const content = JSON.stringify(events, null, 2);
    const updatedAtMs = Math.max(...storedEvents.map((entry) => entry.createdAt));
    artifacts.push({
      kind: "event-log",
      workspaceDir: params.workspaceDir,
      relativePath: MEMORY_HOST_EVENTS_RELATIVE_PATH,
      absolutePath: `sqlite:plugin_state_entries/memory-core/memory-host.events/${memoryHostWorkspacePrefix(params.workspaceDir)}`,
      agentIds: [...params.agentIds],
      contentType: "json",
      content,
      updatedAtMs,
      sizeBytes: Buffer.byteLength(content),
    });
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
}): Promise<MemoryPluginPublicArtifact[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    artifacts.push(
      ...(await listMemoryWorkspacePublicArtifacts({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  return artifacts;
}
