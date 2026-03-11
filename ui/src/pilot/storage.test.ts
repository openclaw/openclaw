import { beforeEach, describe, expect, it } from "vitest";
import {
  PILOT_PROJECT_STORAGE_KEY,
  clearPilotProjectRecord,
  inferJurisdictionFromAddress,
  readPilotProjectRecord,
  writePilotProjectRecord,
} from "./storage";

describe("pilot storage", () => {
  beforeEach(() => {
    clearPilotProjectRecord(window.localStorage);
  });

  it("writes and reads project setup records", () => {
    const record = {
      parcelId: "APN 123-456-789",
      address: "100 Main St, Austin, TX",
      projectScope: "Civil entitlement due diligence",
      projectType: "entitlement",
      objectives: ["jurisdiction", "zoning"],
      inferredJurisdiction: "Austin, TX",
      createdAtIso: "2026-03-11T00:00:00.000Z",
    };
    writePilotProjectRecord(record, window.localStorage);
    expect(readPilotProjectRecord(window.localStorage)).toEqual(record);
  });

  it("returns null for malformed records", () => {
    window.localStorage.setItem(
      PILOT_PROJECT_STORAGE_KEY,
      JSON.stringify({
        parcelId: "APN 123-456-789",
        address: "100 Main St, Austin, TX",
      }),
    );

    expect(readPilotProjectRecord(window.localStorage)).toBeNull();
  });

  it("infers jurisdiction from city and state", () => {
    expect(inferJurisdictionFromAddress("100 Main St, Austin, TX")).toBe("Austin, TX");
    expect(inferJurisdictionFromAddress("Unknown location")).toBe("Pending address verification");
  });
});
