import { describe, expect, it } from "vitest";
import { recoveryKitLines } from "./kit-export.ts";

describe("recovery kit export", () => {
  it("puts the secret, fingerprint, owner, date and first claw on the kit", () => {
    const lines = recoveryKitLines({
      kit: { text: "OCK1-TEST", rootFingerprint: "4F2KQ-9XW7M", rootPub: "ed25519:x" as never },
      hostname: "studio-k7x2q.crabd.xyz",
      owner: "owner@example.test",
      createdAt: new Date("2026-10-31T12:00:00Z"),
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        "Recovery code: OCK1-TEST",
        "Recovery kit ID: 4F2KQ-9XW7M",
        "Owner: owner@example.test",
        "Created: 2026-10-31",
        "First claw: https://studio-k7x2q.crabd.xyz",
      ]),
    );
  });
});
