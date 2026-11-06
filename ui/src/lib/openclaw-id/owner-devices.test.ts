import { describe, expect, it, vi } from "vitest";
import {
  formatEd25519PublicKey,
  generateEd25519Signer,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { loadOwnerDeviceSigner } from "./device-key.ts";
import { approverOf, devicesApprovedBy, signOwnerDeviceRevocation } from "./owner-devices.ts";
import type { OpenClawIdOwnerDevice, OpenClawIdPeopleLink } from "./types.ts";

// mock-isolation: the owner device key comes from each test instead of browser storage.
vi.mock("./device-key.ts", () => ({ loadOwnerDeviceSigner: vi.fn() }));

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

describe("owner device revocation", () => {
  it("signs for this claw at the seq it last read, and refuses without one", async () => {
    const signer = await generateEd25519Signer();
    vi.mocked(loadOwnerDeviceSigner).mockResolvedValue(signer);
    const own = { ...device("own", "root"), devicePub: formatEd25519PublicKey(signer.publicKey) };
    const targetKey = formatEd25519PublicKey((await generateEd25519Signer()).publicKey);
    const target = { ...device("laptop", "own"), devicePub: targetKey };
    const link = { clawId: "c".repeat(32), seq: 7, ownerDevices: [own, target] };
    const signed = await signOwnerDeviceRevocation(link as OpenClawIdPeopleLink, target);
    expect(signed.body).toMatchObject({ claw_id: "c".repeat(32), seq: 7 });
    const stale = { ...link, seq: undefined } as OpenClawIdPeopleLink;
    await expect(signOwnerDeviceRevocation(stale, target)).rejects.toThrow("not an owner device");
  });
});
