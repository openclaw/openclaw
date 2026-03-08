import { describe, expect, it } from "vitest";
import {
  createEvidenceRowId,
  createIncidentBundleId,
  createSpecialistFindingsEnvelopeId,
} from "./evidence.js";

describe("sre evidence contracts", () => {
  it("creates deterministic evidence row ids regardless of entity order", () => {
    const left = createEvidenceRowId({
      source: "prometheus",
      summary: "5xx rate elevated",
      observedAt: "2026-03-06T10:00:00.000Z",
      entityIds: ["service:b", "service:a"],
    });
    const right = createEvidenceRowId({
      source: "prometheus",
      summary: "5xx rate elevated",
      observedAt: "2026-03-06T10:00:00.000Z",
      entityIds: ["service:a", "service:b"],
    });

    expect(left).toBe(right);
  });

  it("creates deterministic incident bundle ids", () => {
    expect(
      createIncidentBundleId({
        incidentId: "incident-123",
        generatedAt: "2026-03-06T10:00:00.000Z",
        evidenceIds: ["evidence:b", "evidence:a"],
      }),
    ).toBe(
      createIncidentBundleId({
        incidentId: "incident-123",
        generatedAt: "2026-03-06T10:00:00.000Z",
        evidenceIds: ["evidence:a", "evidence:b"],
      }),
    );
  });

  it("creates deterministic specialist envelope ids", () => {
    const envelopeId = createSpecialistFindingsEnvelopeId({
      incidentId: "incident-123",
      specialistId: "sre-k8s",
      generatedAt: "2026-03-06T10:00:00.000Z",
    });

    expect(envelopeId).toMatch(/^findings:[0-9a-f]{16}$/);
  });
});
