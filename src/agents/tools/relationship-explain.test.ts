import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { createRelationshipExplainTool } from "./relationship-explain.js";

const tempRoots: string[] = [];

async function createGraphState(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relationship-explain-"));
  tempRoots.push(root);
  const graphDir = path.join(root, "state", "sre-graph");
  await fs.mkdir(graphDir, { recursive: true });
  await fs.writeFile(
    path.join(graphDir, "latest-by-entity.json"),
    JSON.stringify(
      {
        version: "sre.relationship-index-latest.v1",
        updatedAt: "2026-03-07T16:20:00.000Z",
        nodes: {},
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
      edgeId: "edge:2",
      from: "entity:a",
      to: "entity:b",
      edgeType: "belongs_to",
      discoveredAt: "2026-03-07T16:20:00.000Z",
      provenance: [
        {
          version: "sre.provenance-ref.v1",
          artifactType: "timeline_event",
          source: "runtime-hook:message_received",
          locator: "msg-1",
          capturedAt: "2026-03-07T16:20:00.000Z",
          attributes: { confidence: 1 },
        },
      ],
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

describe("relationship_explain", () => {
  it("returns edge provenance and confidence", async () => {
    const root = await createGraphState();
    const tool = createRelationshipExplainTool();
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const result = await tool.execute("call-1", { from: "entity:a", to: "entity:b" });
      expect(result.details).toMatchObject({
        matches: [
          {
            edgeType: "belongs_to",
            confidence: 1,
            provenance: [{ source: "runtime-hook:message_received" }],
          },
        ],
      });
    });
  });
});
