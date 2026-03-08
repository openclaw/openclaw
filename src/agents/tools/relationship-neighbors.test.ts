import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { createRelationshipNeighborsTool } from "./relationship-neighbors.js";

const tempRoots: string[] = [];

async function createGraphState(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relationship-neighbors-"));
  tempRoots.push(root);
  const graphDir = path.join(root, "state", "sre-graph");
  await fs.mkdir(graphDir, { recursive: true });
  await fs.writeFile(
    path.join(graphDir, "latest-by-entity.json"),
    JSON.stringify(
      {
        version: "sre.relationship-index-latest.v1",
        updatedAt: "2026-03-07T16:10:00.000Z",
        nodes: {
          "entity:a": {
            version: "sre.relationship-index-node.v1",
            entityId: "entity:a",
            entityType: "service",
            observedAt: "2026-03-07T16:10:00.000Z",
          },
          "entity:b": {
            version: "sre.relationship-index-node.v1",
            entityId: "entity:b",
            entityType: "deployment",
            observedAt: "2026-03-07T16:10:00.000Z",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(graphDir, "edges.ndjson"),
    `${JSON.stringify({
      version: "sre.relationship-edge.v1",
      edgeId: "edge:1",
      from: "entity:a",
      to: "entity:b",
      edgeType: "depends_on",
      discoveredAt: "2026-03-07T16:10:00.000Z",
      provenance: [],
    })}\n`,
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("relationship_neighbors", () => {
  it("returns neighbor edges and entities", async () => {
    const root = await createGraphState();
    const tool = createRelationshipNeighborsTool();
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const result = await tool.execute("call-1", { entityId: "entity:a" });
      expect(result.details).toMatchObject({
        entityId: "entity:a",
        neighbors: [
          {
            edge: { edgeType: "depends_on" },
            neighbor: { entityId: "entity:b" },
          },
        ],
      });
    });
  });
});
