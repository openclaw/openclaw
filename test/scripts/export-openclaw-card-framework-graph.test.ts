import { describe, expect, it } from "vitest";
import { buildCardFrameworkGraph } from "../../scripts/export-openclaw-card-framework-graph.mjs";

function createCard(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "source-card",
    type: "source",
    title: "Source card",
    openclawTarget: "docs",
    linksTo: ["module-card"],
    sourceUrls: ["docs/source.md"],
    validation: ["pnpm check:openclaw-card-framework"],
    risk: ["drift"],
    contract: "contract",
    humanReadableCheck: "readable",
    ...overrides,
  };
}

describe("export-openclaw-card-framework-graph", () => {
  it("converts cards into deterministic nodes and links", () => {
    const graph = buildCardFrameworkGraph([
      createCard({
        id: "source-3d-viewpoint-node-graph-standards",
        title: "3D source",
        linksTo: ["module-3d-viewpoint-node-model", "validation-readable-card-gate"],
      }),
      createCard({
        id: "module-3d-viewpoint-node-model",
        type: "module",
        title: "3D module",
        openclawTarget: "runtime",
        linksTo: ["contract-3d-viewpoint-node-graph-gate"],
      }),
      createCard({
        id: "contract-3d-viewpoint-node-graph-gate",
        type: "contract",
        title: "3D contract",
        openclawTarget: "runtime",
        linksTo: ["validation-readable-card-gate"],
      }),
      createCard({
        id: "validation-readable-card-gate",
        type: "validation",
        title: "Validation",
        openclawTarget: "runtime",
        linksTo: ["source-3d-viewpoint-node-graph-standards"],
      }),
    ]);

    expect(graph.graph.nodes).toHaveLength(4);
    expect(graph.graph.links).toHaveLength(5);
    expect(graph.graph.missingLinks).toHaveLength(0);
    expect(graph.graph.duplicateNodeIds).toHaveLength(0);
    expect(graph.graph.nodes[0]).toMatchObject({
      id: "source-3d-viewpoint-node-graph-standards",
      type: "source",
      openclawTarget: "docs",
      outgoing: 2,
    });
    expect(graph.graph.nodes[0].position).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(
      graph.viewpoints.find((viewpoint) => viewpoint.id === "3d-viewpoint-node-model")?.nodeIds,
    ).toContain("module-3d-viewpoint-node-model");
  });

  it("keeps missing link evidence in the exported graph", () => {
    const graph = buildCardFrameworkGraph([
      createCard({
        id: "source-card",
        linksTo: ["missing-card"],
      }),
    ]);

    expect(graph.graph.links).toMatchObject([
      {
        source: "source-card",
        target: "missing-card",
        validTarget: false,
      },
    ]);
    expect(graph.graph.missingLinks).toEqual([{ source: "source-card", target: "missing-card" }]);
  });
});
