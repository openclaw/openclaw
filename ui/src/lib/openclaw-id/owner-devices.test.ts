import { describe, expect, it } from "vitest";
import { approverOf, devicesApprovedBy } from "./owner-devices.ts";
import type { OpenClawIdOwnerDevice } from "./types.ts";

// A listed owner device `name`, approved by the device `approvedBy` (or the kit: "root").
function device(name: string, approvedBy: string): OpenClawIdOwnerDevice {
  return {
    devicePub: `ed25519:${name}`,
    deviceFp: `fp:${name}`,
    label: name,
    peerKeys: [],
    approvedBy: approvedBy === "root" ? "root" : `fp:${approvedBy}`,
    lastSeen: 0,
    cert: {} as OpenClawIdOwnerDevice["cert"],
  };
}

describe("owner devices", () => {
  const local = device("local", "root");
  const laptop = device("laptop", "local");
  const phone = device("phone", "laptop");
  const kitDevice = device("kit", "root");
  const orphan = device("orphan", "gone");
  const all = [local, laptop, phone, kitDevice, orphan];

  it("previews every device a revoked device approved, directly or further down", () => {
    expect(devicesApprovedBy(all, laptop).map((d) => d.label)).toEqual(["phone"]);
    expect(devicesApprovedBy(all, local).map((d) => d.label)).toEqual(["laptop", "phone"]);
    expect(devicesApprovedBy(all, kitDevice)).toEqual([]);
  });

  it("names the approver: the recovery kit, a listed device, or a removed one", () => {
    expect(approverOf(all, local)).toEqual({ kind: "kit" });
    expect(approverOf(all, phone)).toEqual({ kind: "device", label: "laptop" });
    expect(approverOf(all, orphan)).toEqual({ kind: "removed" });
  });
});
