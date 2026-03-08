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

function toNdjson(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function ensureStoreDir(rootDir: string): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
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
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as T;
    const key = parsed[keyField];
    if (typeof key === "string" && key) {
      index.set(key, parsed);
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
    fs.writeFile(paths.nodesPath, toNdjson([...nodes.values()]), "utf8"),
    fs.writeFile(paths.edgesPath, toNdjson([...edges.values()]), "utf8"),
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
  writes.push(fs.writeFile(paths.latestByEntityPath, JSON.stringify(latest, null, 2), "utf8"));
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
}

export async function readRelationshipIndexLatestSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RelationshipIndexLatestSnapshot | undefined> {
  return readLatestSnapshot(resolveRelationshipIndexStorePaths(env).latestByEntityPath);
}
