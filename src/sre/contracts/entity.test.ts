import { describe, expect, it } from "vitest";
import { createEntityId, createProvenanceRef, createRelationshipEdgeId } from "./entity.js";

describe("sre entity contracts", () => {
  it("creates deterministic entity ids", () => {
    expect(createEntityId("service", "openclaw-sre", "gateway")).toBe(
      createEntityId("service", "openclaw-sre", "gateway"),
    );
  });

  it("creates deterministic relationship edge ids", () => {
    expect(
      createRelationshipEdgeId({
        from: "service:123",
        to: "repo:456",
        edgeType: "defined_in",
      }),
    ).toBe(
      createRelationshipEdgeId({
        from: "service:123",
        to: "repo:456",
        edgeType: "defined_in",
      }),
    );
  });

  it("adds a stable fingerprint to provenance refs", () => {
    const ref = createProvenanceRef({
      artifactType: "repo_file",
      source: "github",
      locator: "src/config/zod-schema.ts",
      capturedAt: "2026-03-06T10:00:00.000Z",
    });

    expect(ref.version).toBe("sre.provenance-ref.v1");
    expect(ref.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
