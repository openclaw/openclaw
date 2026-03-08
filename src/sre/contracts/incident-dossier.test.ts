import { describe, expect, it } from "vitest";
import { createIncidentDossierId, createIncidentDossierIndex } from "./incident-dossier.js";

describe("sre incident dossier contracts", () => {
  it("creates deterministic dossier ids", () => {
    expect(
      createIncidentDossierId({
        incidentId: "incident-123",
        updatedAt: "2026-03-06T10:00:00.000Z",
      }),
    ).toBe(
      createIncidentDossierId({
        incidentId: "incident-123",
        updatedAt: "2026-03-06T10:00:00.000Z",
      }),
    );
  });

  it("normalizes index arrays into stable order", () => {
    const dossier = createIncidentDossierIndex({
      incidentId: "incident-123",
      title: "gateway degraded",
      status: "open",
      updatedAt: "2026-03-06T10:00:00.000Z",
      provenance: [],
      entityIds: ["entity:b", "entity:a"],
      bundleIds: ["bundle:b", "bundle:a"],
      planIds: ["plan:b", "plan:a"],
      timeline: [
        {
          at: "2026-03-06T10:02:00.000Z",
          kind: "note",
          refId: "note-b",
          summary: "second",
        },
        {
          at: "2026-03-06T10:01:00.000Z",
          kind: "note",
          refId: "note-a",
          summary: "first",
        },
      ],
    });

    expect(dossier.version).toBe("sre.incident-dossier-index.v1");
    expect(dossier.entityIds).toEqual(["entity:a", "entity:b"]);
    expect(dossier.bundleIds).toEqual(["bundle:a", "bundle:b"]);
    expect(dossier.planIds).toEqual(["plan:a", "plan:b"]);
    expect(dossier.timeline.map((entry) => entry.refId)).toEqual(["note-a", "note-b"]);
  });
});
