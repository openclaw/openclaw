import fs from "node:fs/promises";
import path from "node:path";
import type { EntityId, JsonValue, RelationshipEdge } from "../../../sre/contracts/entity.js";
import { logSreMetric } from "../../../sre/observability/log.js";
import { resolveSreStatePaths } from "../../../sre/state/paths.js";

export const RELATIONSHIP_INDEX_NODE_VERSION = "sre.relationship-index-node.v1";
export const RELATIONSHIP_INDEX_LATEST_VERSION = "sre.relationship-index-latest.v1";

export type RelationshipIndexNode = {
  version: typeof RELATIONSHIP_INDEX_NODE_VERSION;
  entityId: EntityId;
  entityType: string;
  observedAt: string;
  attributes?: { [key: string]: JsonValue };
};

export type RelationshipIndexLatestSnapshot = {
  version: typeof RELATIONSHIP_INDEX_LATEST_VERSION;
  updatedAt: string;
  nodes: Record<string, RelationshipIndexNode>;
};

export type RelationshipIndexUpdate = {
  nodes: RelationshipIndexNode[];
  edges: RelationshipEdge[];
};

export type RelationshipIndexStorePaths = {
  rootDir: string;
  nodesPath: string;
  edgesPath: string;
  latestByEntityPath: string;
};

type RelationshipIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  compactAfterBytes?: number;
};

const DEFAULT_COMPACT_AFTER_BYTES = 256 * 1024;
const relationshipIndexWriteQueues = new Map<string, Promise<void>>();

function toNdjson(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function ensureStoreDir(rootDir: string): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
}

/**
 * Write content to a temp file in the same directory, then atomically rename
 * to the target path. This prevents partial/truncated files surviving OOM or
 * crash events.
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp.${path.basename(filePath)}.${process.pid}.${Date.now()}`);
  try {
    await fs.writeFile(tmpPath, data, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Best-effort cleanup of temp file on failure
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Move a corrupt file to a quarantine path so it does not re-trigger error
 * loops on subsequent reads. Returns the quarantine path for logging.
 */
async function quarantineCorruptFile(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const quarantinePath = path.join(dir, `.quarantine.${base}.${Date.now()}`);
  await fs.rename(filePath, quarantinePath);
  return quarantinePath;
}

function runSerializedByKey<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tracked = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tracked);
  void tracked.finally(() => {
    if (queues.get(key) === tracked) {
      queues.delete(key);
    }
  });
  return run;
}

async function readLatestSnapshot(
  filePath: string,
): Promise<RelationshipIndexLatestSnapshot | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as RelationshipIndexLatestSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    // Quarantine corrupt/truncated JSON so it does not re-trigger on every write
    if (error instanceof SyntaxError) {
      logSreMetric("relationship_index_snapshot_corrupt", { path: filePath, error: error.message });
      try {
        const quarantinePath = await quarantineCorruptFile(filePath);
        logSreMetric("relationship_index_snapshot_quarantined", {
          path: filePath,
          quarantinePath,
        });
      } catch (quarantineError) {
        logSreMetric("relationship_index_snapshot_quarantine_failed", {
          path: filePath,
          error:
            quarantineError instanceof Error ? quarantineError.message : String(quarantineError),
        });
      }
      return undefined;
    }
    throw error;
  }
}

async function readJsonLines<T extends Record<string, unknown>>(
  filePath: string,
  keyField: keyof T,
): Promise<Map<string, T>> {
  const index = new Map<string, T>();
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return index;
    }
    throw error;
  }
  let corruptLineCount = 0;
  let validLineCount = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch (error) {
      corruptLineCount++;
      logSreMetric("relationship_index_ndjson_corrupt_line", {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
        lineLength: line.length,
      });
      continue;
    }
    const key = parsed[keyField];
    if (typeof key === "string" && key) {
      validLineCount++;
      index.set(key, parsed);
    }
  }
  // If more than half the lines are corrupt, quarantine the file so it
  // does not keep triggering the error log on every compaction cycle.
  const totalNonEmpty = validLineCount + corruptLineCount;
  if (corruptLineCount > 0 && totalNonEmpty > 0 && corruptLineCount > totalNonEmpty / 2) {
    logSreMetric("relationship_index_ndjson_majority_corrupt", {
      path: filePath,
      corruptLines: corruptLineCount,
      validLines: validLineCount,
    });
    try {
      const quarantinePath = await quarantineCorruptFile(filePath);
      logSreMetric("relationship_index_ndjson_quarantined", {
        path: filePath,
        quarantinePath,
      });
      // Return only valid entries — caller will rewrite the file via compaction
    } catch {
      // File may already be gone or locked; continue with partial data
    }
  }
  return index;
}

async function maybeCompactRelationshipIndex(
  paths: RelationshipIndexStorePaths,
  compactAfterBytes: number,
): Promise<void> {
  const [nodesStat, edgesStat] = await Promise.all([
    fs.stat(paths.nodesPath).catch(() => null),
    fs.stat(paths.edgesPath).catch(() => null),
  ]);
  const totalBytes = (nodesStat?.size ?? 0) + (edgesStat?.size ?? 0);
  if (totalBytes < compactAfterBytes) {
    return;
  }

  const [nodes, edges] = await Promise.all([
    readJsonLines<RelationshipIndexNode>(paths.nodesPath, "entityId"),
    readJsonLines<RelationshipEdge>(paths.edgesPath, "edgeId"),
  ]);
  await Promise.all([
    atomicWriteFile(paths.nodesPath, toNdjson([...nodes.values()])),
    atomicWriteFile(paths.edgesPath, toNdjson([...edges.values()])),
  ]);
}

export function resolveRelationshipIndexStorePaths(
  env: NodeJS.ProcessEnv = process.env,
): RelationshipIndexStorePaths {
  const rootDir = resolveSreStatePaths(env).graphDir;
  return {
    rootDir,
    nodesPath: path.join(rootDir, "nodes.ndjson"),
    edgesPath: path.join(rootDir, "edges.ndjson"),
    latestByEntityPath: path.join(rootDir, "latest-by-entity.json"),
  };
}

export async function appendRelationshipIndexUpdate(
  update: RelationshipIndexUpdate,
  options?: RelationshipIndexStoreOptions,
): Promise<void> {
  if (update.nodes.length === 0 && update.edges.length === 0) {
    return;
  }

  const paths = resolveRelationshipIndexStorePaths(options?.env ?? process.env);
  await runSerializedByKey(relationshipIndexWriteQueues, paths.rootDir, async () => {
    await ensureStoreDir(paths.rootDir);
    const existingLatest = await readLatestSnapshot(paths.latestByEntityPath);

    const writes: Promise<void>[] = [];
    if (update.nodes.length > 0) {
      writes.push(fs.appendFile(paths.nodesPath, toNdjson(update.nodes), "utf8"));
    }
    if (update.edges.length > 0) {
      writes.push(fs.appendFile(paths.edgesPath, toNdjson(update.edges), "utf8"));
    }

    const latest: RelationshipIndexLatestSnapshot = {
      version: RELATIONSHIP_INDEX_LATEST_VERSION,
      updatedAt: new Date().toISOString(),
      nodes: {
        ...existingLatest?.nodes,
        ...Object.fromEntries(update.nodes.map((node) => [node.entityId, node])),
      },
    };
    writes.push(atomicWriteFile(paths.latestByEntityPath, JSON.stringify(latest)));
    await Promise.all(writes);
    logSreMetric("relationship_index_write", {
      nodes: update.nodes.length,
      edges: update.edges.length,
      latestNodes: Object.keys(latest.nodes).length,
    });

    await maybeCompactRelationshipIndex(
      paths,
      options?.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES,
    );
  });
}

export async function readRelationshipIndexLatestSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RelationshipIndexLatestSnapshot | undefined> {
  return readLatestSnapshot(resolveRelationshipIndexStorePaths(env).latestByEntityPath);
}
