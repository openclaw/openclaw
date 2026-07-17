/**
 * Public SDK facade for memory host runtime core and public artifact discovery.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { sha256HexPrefix } from "../infra/crypto-digest.js";
import { withFileLock } from "../infra/file-lock.js";
import { FsSafeError, root as createFsSafeRoot } from "../infra/fs-safe.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";
import { listStoredMemoryHostEvents } from "../memory-host-sdk/event-store.js";
import type { MemoryPluginPublicArtifact } from "../plugins/memory-state.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { resolveMemoryDreamingWorkspaces } from "./memory-core-host-status.js";

const MEMORY_HOST_EVENTS_RELATIVE_PATH = "memory/events/memory-host-events.jsonl";
const MAX_MEMORY_HOST_PUBLIC_EXPORT_EVENTS = 1_000;
const MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES = 1024 * 1024;
const MEMORY_HOST_EVENT_EXPORT_LOCK_OPTIONS = {
  retries: { retries: 20, factor: 1.3, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
} as const;
const memoryHostEventExportQueue = new KeyedAsyncQueue();

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    (error instanceof FsSafeError && code === "not-found")
  );
}

function resolveMemoryHostEventExportLockTarget(workspaceDir: string): string {
  const workspaceHash = sha256HexPrefix(path.resolve(workspaceDir), 32);
  return path.join(resolveStateDir(), `.memory-host-events-export-${workspaceHash}`);
}

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

function serializeMemoryHostEventExport(
  storedEvents: ReturnType<typeof listStoredMemoryHostEvents>,
): string {
  const lines: string[] = [];
  let sizeBytes = 0;
  for (const entry of storedEvents.toReversed()) {
    const line = JSON.stringify(entry.value.event);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (sizeBytes + lineBytes > MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES) {
      break;
    }
    lines.push(line);
    sizeBytes += lineBytes;
  }
  return lines.toReversed().join("\n") + "\n";
}

async function materializeMemoryHostEventExport(params: {
  workspaceDir: string;
}): Promise<string | undefined> {
  const requestedWorkspace = path.resolve(params.workspaceDir);
  const workspace = await fs.stat(requestedWorkspace).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!workspace?.isDirectory()) {
    return undefined;
  }
  const workspaceRoot = await createFsSafeRoot(requestedWorkspace, {
    hardlinks: "reject",
    mkdir: true,
    mode: 0o600,
    symlinks: "reject",
  });
  const workspaceKey = workspaceRoot.rootReal;
  // The queue handles re-entrant calls in this process; the sidecar lock makes
  // snapshot, cleanup, and replacement one ordered operation across processes.
  return memoryHostEventExportQueue.enqueue(workspaceKey, async () => {
    const absolutePath = path.join(workspaceKey, ...MEMORY_HOST_EVENTS_RELATIVE_PATH.split("/"));
    return await withFileLock(
      resolveMemoryHostEventExportLockTarget(workspaceKey),
      MEMORY_HOST_EVENT_EXPORT_LOCK_OPTIONS,
      async () => {
        const storedEvents = listStoredMemoryHostEvents({
          workspaceDir: workspaceKey,
          limit: MAX_MEMORY_HOST_PUBLIC_EXPORT_EVENTS,
        });
        if (storedEvents.length === 0) {
          try {
            await workspaceRoot.remove(MEMORY_HOST_EVENTS_RELATIVE_PATH);
          } catch (error) {
            if (isMissingPathError(error)) {
              return undefined;
            }
            throw error;
          }
          // Persist removal before releasing the cross-process export lock. Otherwise
          // a crash can resurrect a stale export after SQLite retention removed it.
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          return undefined;
        }
        const content = serializeMemoryHostEventExport(storedEvents);
        // SQLite is authoritative. Reading this bounded export only avoids replacing
        // an unchanged named artifact and preserves stable mtimes for bridge consumers.
        const existing = await workspaceRoot
          .readText(MEMORY_HOST_EVENTS_RELATIVE_PATH)
          .catch((error: unknown) => {
            if (isMissingPathError(error)) {
              return undefined;
            }
            throw error;
          });
        if (existing !== content) {
          await workspaceRoot.write(MEMORY_HOST_EVENTS_RELATIVE_PATH, content, {
            mkdir: true,
            mode: 0o600,
          });
        }
        return absolutePath;
      },
    );
  });
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

  const eventExportPath = await materializeMemoryHostEventExport({
    workspaceDir: params.workspaceDir,
  });
  if (eventExportPath) {
    artifacts.push({
      kind: "event-log",
      workspaceDir: params.workspaceDir,
      relativePath: MEMORY_HOST_EVENTS_RELATIVE_PATH,
      absolutePath: eventExportPath,
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
