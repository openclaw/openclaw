import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelationshipEdge } from "../../../sre/contracts/entity.js";
import {
  appendRelationshipIndexUpdate,
  resolveRelationshipIndexStorePaths,
  type RelationshipIndexNode,
} from "./store.js";

const tempRoots: string[] = [];

async function createStateEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relationship-index-"));
  tempRoots.push(root);
  return { OPENCLAW_STATE_DIR: root };
}

async function readNdjson(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.split("\n").filter(Boolean);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("relationship index store", () => {
  it("merges latest-by-entity across multiple appends", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:1",
            entityType: "message",
            observedAt: "2026-03-07T15:30:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );
    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "thread:1",
            entityType: "thread",
            observedAt: "2026-03-07T15:31:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(Object.keys(latest.nodes).toSorted()).toEqual(["message:1", "thread:1"]);
  });

  it("compacts duplicate nodes and edges after the threshold is exceeded", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);
    const node: RelationshipIndexNode = {
      version: "sre.relationship-index-node.v1",
      entityId: "message:dup",
      entityType: "message",
      observedAt: "2026-03-07T15:32:00.000Z",
    };
    const edge: RelationshipEdge = {
      version: "sre.relationship-edge.v1",
      edgeId: "edge:dup",
      from: "message:dup",
      to: "thread:dup",
      edgeType: "belongs_to",
      discoveredAt: "2026-03-07T15:32:00.000Z",
      provenance: [],
    };

    await appendRelationshipIndexUpdate(
      { nodes: [node], edges: [edge] },
      { env, compactAfterBytes: 1 },
    );
    await appendRelationshipIndexUpdate(
      { nodes: [node], edges: [edge] },
      { env, compactAfterBytes: 1 },
    );

    expect(await readNdjson(paths.nodesPath)).toHaveLength(1);
    expect(await readNdjson(paths.edgesPath)).toHaveLength(1);
  });

  it("serializes concurrent appends so latest-by-entity does not lose updates", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);
    const firstLatestWriteStarted = createDeferred<void>();
    const releaseFirstLatestWrite = createDeferred<void>();
    const originalWriteFile = fs.writeFile.bind(fs) as (
      ...args: Parameters<typeof fs.writeFile>
    ) => ReturnType<typeof fs.writeFile>;
    let blockedFirstLatestWrite = false;

    vi.spyOn(fs, "writeFile").mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        const [filePath] = args;
        if (!blockedFirstLatestWrite && filePath === paths.latestByEntityPath) {
          blockedFirstLatestWrite = true;
          firstLatestWriteStarted.resolve(undefined);
          await releaseFirstLatestWrite.promise;
        }
        return originalWriteFile(...args);
      },
    );

    const firstAppend = appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:concurrent-1",
            entityType: "message",
            observedAt: "2026-03-07T15:33:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );
    await firstLatestWriteStarted.promise;

    const secondAppend = appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "thread:concurrent-2",
            entityType: "thread",
            observedAt: "2026-03-07T15:34:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    releaseFirstLatestWrite.resolve(undefined);
    await Promise.all([firstAppend, secondAppend]);

    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(Object.keys(latest.nodes).toSorted()).toEqual([
      "message:concurrent-1",
      "thread:concurrent-2",
    ]);
    expect(await readNdjson(paths.nodesPath)).toHaveLength(2);
  });
});
