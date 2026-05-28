import { describe, expect, it } from "vitest";
import { buildCardFrameworkViewerHtml } from "../../scripts/render-openclaw-card-framework-viewer.mjs";

function createGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "openclaw-card-framework-graph",
    source: {
      registryPath: "reports/openclaw-card-framework-cards.json",
      requiredValidation: "pnpm check:openclaw-card-framework",
    },
    validation: {
      ok: true,
      simulation: {
        iterations: 1000,
        correct: 1000,
        falseAccepted: 0,
        falseBlocked: 0,
      },
    },
    graph: {
      nodes: [
        {
          id: "module-3d-viewpoint-node-model",
          label: "3D module",
          type: "module",
          openclawTarget: "runtime",
          componentRole: null,
          componentPaths: [],
          sourceUrls: ["reports/openclaw-card-framework-graph.json"],
          validation: ["pnpm openclaw:card:graph:check"],
          risk: ["drift"],
          contract: "read-only graph",
          humanReadableCheck: "readable",
          incoming: 1,
          outgoing: 1,
          linkedBy: ["source-3d-viewpoint-node-graph-standards"],
          linksTo: ["contract-3d-viewpoint-node-graph-gate"],
          position: { x: 360, y: 720, z: 90 },
          forceGraph: { nodeVal: 3, nodeLabel: "3D module" },
        },
      ],
      links: [
        {
          id: "module-3d-viewpoint-node-model->contract-3d-viewpoint-node-graph-gate#0",
          source: "module-3d-viewpoint-node-model",
          target: "contract-3d-viewpoint-node-graph-gate",
          relation: "linksTo",
          validTarget: true,
        },
      ],
      missingLinks: [],
      duplicateNodeIds: [],
    },
    viewpoints: [
      {
        id: "3d-viewpoint-node-model",
        title: "3D viewpoint / node graph branch",
        primaryNodeIds: ["module-3d-viewpoint-node-model"],
        nodeIds: ["module-3d-viewpoint-node-model"],
      },
    ],
    ...overrides,
  };
}

describe("render-openclaw-card-framework-viewer", () => {
  it("embeds graph data and read-only detail surfaces in the viewer", () => {
    const html = buildCardFrameworkViewerHtml(createGraph());

    expect(html).toContain("OpenClaw Card Graph");
    expect(html).toContain("graph-data");
    expect(html).toContain("Read-only graph. Nodes cannot execute tasks.");
    expect(html).toContain("module-3d-viewpoint-node-model");
    expect(html).not.toContain("fetch(");
  });

  it("escapes embedded graph JSON so script tags cannot break out", () => {
    const html = buildCardFrameworkViewerHtml(
      createGraph({
        graph: {
          nodes: [
            {
              id: "bad-node",
              label: "</script><script>alert(1)</script>",
              type: "source",
              openclawTarget: "docs",
              linksTo: [],
              linkedBy: [],
              sourceUrls: [],
              validation: [],
              risk: [],
              position: { x: 0, y: 0, z: 0 },
            },
          ],
          links: [],
          missingLinks: [],
          duplicateNodeIds: [],
        },
      }),
    );

    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>alert(1)</script>");
  });
});
