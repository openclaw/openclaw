import { beforeEach, describe, expect, it } from "vitest";
import { createPilotProject, inferJurisdictionName, loadPilotSnapshot } from "./storage.ts";

describe("pilot storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("seeds the pilot dashboard snapshot", () => {
    const snapshot = loadPilotSnapshot();
    expect(snapshot.projects.length).toBeGreaterThan(0);
    expect(snapshot.jurisdictions.some((entry) => entry.name === "Austin, TX")).toBe(true);
  });

  it("infers a jurisdiction from the address", () => {
    expect(inferJurisdictionName("100 Main St, Austin, TX")).toBe("Austin, TX");
    expect(inferJurisdictionName("500 Unknown Ave")).toBe("Unresolved jurisdiction");
  });

  it("persists project, parcel, and jurisdiction records independently", () => {
    const created = createPilotProject({
      parcelId: "APN 123-456-789",
      address: "100 Main St, Austin, TX",
      scope: "Civil entitlement due diligence",
    });
    expect(created.project.parcelId).toBe("APN 123-456-789");
    expect(created.parcel.id).not.toBe(created.project.id);
    expect(created.jurisdiction.name).toBe("Austin, TX");

    const snapshot = loadPilotSnapshot();
    expect(snapshot.projects[0]?.id).toBe(created.project.id);
    expect(snapshot.parcels[0]?.id).toBe(created.parcel.id);
    expect(snapshot.jurisdictions.some((entry) => entry.id === created.jurisdiction.id)).toBe(true);
  });
});
