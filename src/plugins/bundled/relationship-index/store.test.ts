import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(async () => {
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
});
