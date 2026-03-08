import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { createRelationshipLookupTool } from "./relationship-lookup.js";

const tempRoots: string[] = [];

async function createGraphState(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relationship-tool-"));
  tempRoots.push(root);
  const graphDir = path.join(root, "state", "sre-graph");
  await fs.mkdir(graphDir, { recursive: true });
  await fs.writeFile(
    path.join(graphDir, "latest-by-entity.json"),
    JSON.stringify(
      {
        version: "sre.relationship-index-latest.v1",
        updatedAt: "2026-03-07T16:00:00.000Z",
        nodes: {
          "entity:1": {
            version: "sre.relationship-index-node.v1",
            entityId: "entity:1",
            entityType: "service",
            observedAt: "2026-03-07T16:00:00.000Z",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(graphDir, "edges.ndjson"), "", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("relationship_lookup", () => {
  it("returns the local entity payload", async () => {
    const root = await createGraphState();
    const tool = createRelationshipLookupTool();
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const result = await tool.execute("call-1", { entityId: "entity:1" });
      expect(result.details).toMatchObject({
        entityId: "entity:1",
        found: true,
        entity: { entityType: "service" },
      });
    });
  });
});
