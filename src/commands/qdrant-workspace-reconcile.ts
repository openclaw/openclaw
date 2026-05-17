import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import {
  WORKSPACE_RECONCILER_ID,
  buildWorkspaceReconcilePlan,
  type WorkspaceReconcilePayload,
  type WorkspaceReconcilePoint,
} from "../memory-host-sdk/host/workspace-reconcile.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";

export const DEFAULT_QDRANT_URL = "http://qdrant:6333";
export const DEFAULT_HOST_QDRANT_URL = "http://127.0.0.1:6333";
export const DEFAULT_QDRANT_COLLECTION = "agent-memory";
export const DEFAULT_QDRANT_WORKSPACE_DIR = "/home/node/.openclaw/workspace";
export const DEFAULT_QDRANT_FASTEMBED_PYTHON =
  "/home/node/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python";
export const QDRANT_URL_ENV = "OPENCLAW_QDRANT_URL";
export const QDRANT_COLLECTION_ENV = "OPENCLAW_QDRANT_COLLECTION";
export const QDRANT_WORKSPACE_DIR_ENV = "OPENCLAW_QDRANT_WORKSPACE_DIR";
export const QDRANT_FASTEMBED_PYTHON_ENV = "OPENCLAW_QDRANT_FASTEMBED_PYTHON";

type ManagedWorkspacePoint = {
  id: string;
  qdrantId: string;
  payload?: Partial<WorkspaceReconcilePayload> | null;
};

type QdrantCollectionInfo = {
  status?: string;
  points_count?: number;
  config?: {
    params?: {
      vectors?: Record<string, unknown> | { size: number; distance: string };
    };
  };
};

type QdrantWorkspaceReconcileSummary = {
  ok: true;
  mode: "dry-run" | "apply";
  collection: string;
  filesScanned: number;
  chunksBuilt: number;
  newPoints: number;
  updatedPoints: number;
  unchangedPoints: number;
  deletedPoints: number;
};

export type QdrantWorkspaceReconcileOptions = {
  apply?: boolean;
  dryRun?: boolean;
  json?: boolean;
  qdrantUrl?: string;
  collection?: string;
  workspaceDir?: string;
  pythonPath?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?: (candidate: string) => boolean;
  homeDir?: string;
};

type QdrantWorkspaceReconcileMode = "dry-run" | "apply";

type QdrantWorkspaceReconcileClassification = {
  unchanged: WorkspaceReconcilePoint[];
  toUpsert: WorkspaceReconcilePoint[];
  toDelete: string[];
};

type QdrantScrollResponse = {
  points?: Array<{
    id: string | number;
    payload?: Partial<WorkspaceReconcilePayload> | null;
  }>;
  next_page_offset?: string | number | null;
};

const FASTEMBED_BRIDGE_SCRIPT = [
  "import json, sys",
  "from fastembed import TextEmbedding",
  'payload = json.loads(sys.stdin.read() or "{}")',
  'texts = payload.get("texts") or []',
  'model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")',
  "vectors = [list(vector) for vector in model.embed(texts)]",
  'sys.stdout.write(json.dumps({"vectors": vectors}))',
].join("\n");

export function workspaceIdToUuid(workspaceId: string): string {
  const hash = crypto.createHash("sha256").update(workspaceId).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function workspaceIdFromPayload(
  payload?: Partial<WorkspaceReconcilePayload> | null,
): string | undefined {
  if (payload?.path !== undefined && payload?.chunk_index !== undefined) {
    return `workspace:${payload.path}#${payload.chunk_index}`;
  }
  return undefined;
}

function resolveOptions(opts: QdrantWorkspaceReconcileOptions) {
  const mode = resolveQdrantWorkspaceReconcileMode(opts);
  const env = opts.env ?? process.env;
  const pathExists = opts.pathExists ?? fs.existsSync;
  const homeDir = opts.homeDir ?? os.homedir();
  const hostWorkspaceDir = `${homeDir}/.openclaw/workspace`;
  const hostPythonPath = `${homeDir}/.openclaw/vendor/uv-tools/data/uv/tools/mcp-server-qdrant/bin/python`;
  const containerDefaultsAvailable =
    pathExists(DEFAULT_QDRANT_WORKSPACE_DIR) || pathExists(DEFAULT_QDRANT_FASTEMBED_PYTHON);
  return {
    mode,
    json: Boolean(opts.json),
    qdrantUrl:
      opts.qdrantUrl ??
      env[QDRANT_URL_ENV] ??
      (containerDefaultsAvailable ? DEFAULT_QDRANT_URL : DEFAULT_HOST_QDRANT_URL),
    collection: opts.collection ?? env[QDRANT_COLLECTION_ENV] ?? DEFAULT_QDRANT_COLLECTION,
    workspaceDir:
      opts.workspaceDir ??
      env[QDRANT_WORKSPACE_DIR_ENV] ??
      (containerDefaultsAvailable ? DEFAULT_QDRANT_WORKSPACE_DIR : hostWorkspaceDir),
    pythonPath:
      opts.pythonPath ??
      env[QDRANT_FASTEMBED_PYTHON_ENV] ??
      (containerDefaultsAvailable ? DEFAULT_QDRANT_FASTEMBED_PYTHON : hostPythonPath),
  };
}

export function resolveQdrantWorkspaceReconcileMode(
  opts: Pick<QdrantWorkspaceReconcileOptions, "apply" | "dryRun">,
): QdrantWorkspaceReconcileMode {
  if (opts.apply && opts.dryRun) {
    throw new Error("Choose either --dry-run or --apply");
  }
  if (opts.apply) {
    return "apply";
  }
  return "dry-run";
}

export function resolveQdrantWorkspaceReconcileOptions(opts: QdrantWorkspaceReconcileOptions) {
  return resolveOptions(opts);
}

async function readQdrantResponseJson<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }
  const body = await response.text().catch(() => "");
  throw new Error(body || `Qdrant request failed with status ${response.status}`);
}

async function fetchQdrantJson<T>(
  baseUrl: string,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
      ...init,
    });
  } catch (err: unknown) {
    const cause = (err as { cause?: unknown })?.cause;
    const code = (err as { code?: string })?.code;
    const syscall = (err as { syscall?: string })?.syscall;
    const details: string[] = [url.href];
    if (code) {
      details.push(`code=${code}`);
    }
    if (syscall) {
      details.push(`syscall=${syscall}`);
    }
    if (cause !== undefined) {
      details.push(`cause=${String(cause)}`);
    }
    throw new Error(`Qdrant fetch failed: ${details.join(" ")}`, { cause: err });
  }
  return readQdrantResponseJson<T>(response);
}

export async function getQdrantCollectionInfo(
  qdrantUrl: string,
  collection: string,
): Promise<QdrantCollectionInfo> {
  const payload = await fetchQdrantJson<{ result?: QdrantCollectionInfo }>(
    qdrantUrl,
    `/collections/${encodeURIComponent(collection)}`,
  );
  return payload.result ?? {};
}

export async function scrollManagedWorkspacePoints(
  qdrantUrl: string,
  collection: string,
): Promise<ManagedWorkspacePoint[]> {
  const points: ManagedWorkspacePoint[] = [];
  let offset: string | number | null | undefined;

  do {
    const payload = await fetchQdrantJson<{ result?: QdrantScrollResponse }>(
      qdrantUrl,
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify({
          limit: 256,
          with_payload: true,
          with_vector: false,
          ...(offset !== undefined && offset !== null ? { offset } : {}),
          filter: {
            must: [
              {
                key: "managed_by",
                match: {
                  value: WORKSPACE_RECONCILER_ID,
                },
              },
            ],
          },
        }),
      },
    );
    const result = payload.result ?? {};
    for (const point of result.points ?? []) {
      const pointId = workspaceIdFromPayload(point.payload) ?? String(point.id);
      points.push({
        id: pointId,
        qdrantId: String(point.id),
        payload: point.payload,
      });
    }
    offset = result.next_page_offset;
  } while (offset !== undefined && offset !== null);

  return points;
}

function resolveCollectionVectorName(info: QdrantCollectionInfo): string | undefined {
  const vectors = info.config?.params?.vectors;
  if (!vectors || typeof vectors !== "object") {
    return undefined;
  }
  if ("size" in vectors && "distance" in vectors) {
    return undefined;
  }
  const names = Object.keys(vectors);
  return names.length > 0 ? names[0] : undefined;
}

function formatCollectionVector(
  vector: number[],
  vectorName?: string,
): number[] | Record<string, number[]> {
  return vectorName ? { [vectorName]: vector } : vector;
}

export async function upsertWorkspacePoints(
  qdrantUrl: string,
  collection: string,
  points: Array<WorkspaceReconcilePoint & { vector: number[] }>,
  vectorName?: string,
): Promise<void> {
  const BATCH_SIZE = 100;
  for (let offset = 0; offset < points.length; offset += BATCH_SIZE) {
    const batch = points.slice(offset, offset + BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }
    await fetchQdrantJson(
      qdrantUrl,
      `/collections/${encodeURIComponent(collection)}/points?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({
          points: batch.map((point) => {
            const payload = Object.assign({}, point.payload, { workspace_id: point.id });
            return {
              id: workspaceIdToUuid(point.id),
              vector: formatCollectionVector(point.vector, vectorName),
              payload,
            };
          }),
        }),
      },
    );
  }
}

export async function deleteManagedWorkspacePointIds(
  qdrantUrl: string,
  collection: string,
  ids: string[],
): Promise<void> {
  const DELETE_BATCH_SIZE = 200;
  for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DELETE_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }
    await fetchQdrantJson(
      qdrantUrl,
      `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
      {
        method: "POST",
        body: JSON.stringify({ points: batch }),
      },
    );
  }
}

export function classifyWorkspacePoints(
  expectedPoints: WorkspaceReconcilePoint[],
  existingPoints: ManagedWorkspacePoint[],
): QdrantWorkspaceReconcileClassification {
  const existingById = new Map(existingPoints.map((point) => [point.id, point]));
  const unchanged: WorkspaceReconcilePoint[] = [];
  const toUpsert: WorkspaceReconcilePoint[] = [];

  for (const point of expectedPoints) {
    const existing = existingById.get(point.id);
    if (existing?.payload?.content_hash === point.payload.content_hash) {
      unchanged.push(point);
      continue;
    }
    toUpsert.push(point);
  }

  const nextIds = new Set(expectedPoints.map((point) => point.id));
  const toDelete = existingPoints
    .filter(
      (point) => point.payload?.managed_by === WORKSPACE_RECONCILER_ID && !nextIds.has(point.id),
    )
    .map((point) => point.qdrantId);

  return { unchanged, toUpsert, toDelete };
}

export function embedWorkspaceTexts(texts: string[], pythonPath: string): number[][] {
  if (texts.length === 0) {
    return [];
  }
  const EMBED_BATCH_SIZE = 50;
  const allVectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
    const result = spawnSync(pythonPath, ["-c", FASTEMBED_BRIDGE_SCRIPT], {
      encoding: "utf8",
      input: JSON.stringify({ texts: batch }),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        typeof result.stderr === "string" && result.stderr.trim() !== ""
          ? result.stderr.trim()
          : `embedding bridge failed with status ${result.status ?? "unknown"}`,
      );
    }
    const parsed = JSON.parse(result.stdout || "{}") as { vectors?: number[][] };
    const vectors = parsed.vectors ?? [];
    if (vectors.length !== batch.length) {
      throw new Error(
        `embedding bridge returned ${vectors.length} vectors for ${batch.length} texts`,
      );
    }
    allVectors.push(...vectors);
  }
  return allVectors;
}

function renderSummary(runtime: RuntimeEnv, summary: QdrantWorkspaceReconcileSummary): void {
  runtime.log(`Qdrant workspace reconcile (${summary.mode})`);
  runtime.log(`Collection: ${summary.collection}`);
  runtime.log(`Files scanned: ${summary.filesScanned}`);
  runtime.log(`Chunks built: ${summary.chunksBuilt}`);
  runtime.log(`New points: ${summary.newPoints}`);
  runtime.log(`Updated points: ${summary.updatedPoints}`);
  runtime.log(`Unchanged points: ${summary.unchangedPoints}`);
  runtime.log(`Deleted points: ${summary.deletedPoints}`);
}

export async function runQdrantWorkspaceReconcileCommand(
  opts: QdrantWorkspaceReconcileOptions,
  runtime: RuntimeEnv,
): Promise<QdrantWorkspaceReconcileSummary> {
  const resolved = resolveOptions(opts);
  const plan = await buildWorkspaceReconcilePlan(resolved.workspaceDir, new Date().toISOString());
  const collectionInfo = await getQdrantCollectionInfo(resolved.qdrantUrl, resolved.collection);
  const collectionVectorName = resolveCollectionVectorName(collectionInfo);
  const existingPoints = await scrollManagedWorkspacePoints(
    resolved.qdrantUrl,
    resolved.collection,
  );
  const classification = classifyWorkspacePoints(plan.points, existingPoints);
  const existingById = new Map(existingPoints.map((point) => [point.id, point]));
  const newPoints = classification.toUpsert.filter((point) => !existingById.has(point.id));
  const updatedPoints = classification.toUpsert.filter((point) => existingById.has(point.id));

  if (resolved.mode === "apply") {
    if (classification.toUpsert.length > 0) {
      runtime.log(`Embedding ${classification.toUpsert.length} chunks...`);
    }
    const vectors = embedWorkspaceTexts(
      classification.toUpsert.map((point) => point.text),
      resolved.pythonPath,
    );
    if (classification.toUpsert.length > 0) {
      runtime.log(`Upserting ${classification.toUpsert.length} points...`);
    }
    await upsertWorkspacePoints(
      resolved.qdrantUrl,
      resolved.collection,
      classification.toUpsert.map((point, index) => ({
        ...point,
        vector: vectors[index] ?? [],
      })),
      collectionVectorName,
    );
    if (classification.toDelete.length > 0) {
      runtime.log(`Removing ${classification.toDelete.length} stale points...`);
    }
    await deleteManagedWorkspacePointIds(
      resolved.qdrantUrl,
      resolved.collection,
      classification.toDelete,
    );
  }

  const summary: QdrantWorkspaceReconcileSummary = {
    ok: true,
    mode: resolved.mode,
    collection: resolved.collection,
    filesScanned: plan.files.length,
    chunksBuilt: plan.points.length,
    newPoints: newPoints.length,
    updatedPoints: updatedPoints.length,
    unchangedPoints: classification.unchanged.length,
    deletedPoints: classification.toDelete.length,
  };

  if (resolved.json) {
    writeRuntimeJson(runtime, summary, 0);
  } else {
    renderSummary(runtime, summary);
  }

  return summary;
}
