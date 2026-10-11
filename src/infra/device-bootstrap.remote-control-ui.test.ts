import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveRemoteControlUiBootstrapPolicy } from "../shared/device-bootstrap-profile.js";
import {
  cancelRemoteControlUiPairingBootstrap,
  issueRemoteControlUiPairingBootstrap,
} from "./device-bootstrap.js";

const publicKey = Buffer.alloc(32, 7).toString("base64url");
const input = {
  deviceId: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
  publicKey,
  displayName: "Synthetic remote browser",
  scopes: ["operator.read"],
  signal: new AbortController().signal,
};
const authority = {
  operatorScopeCeiling: ["operator.read", "operator.write"],
  assertCurrent: () => {},
};

describe("remote Control UI bootstrap preparation", () => {
  it.each([
    { scopes: ["operator.read"], expected: ["operator.read"] },
    { scopes: ["operator.write", "operator.read"], expected: ["operator.read", "operator.write"] },
  ])(
    "retains the exact requested set in the manual enrollment policy: $scopes",
    ({ scopes, expected }) => {
      const policy = resolveRemoteControlUiBootstrapPolicy({ ...authority, scopes });
      expect(policy).toMatchObject({
        approval: "manual",
        role: "operator",
        scopes: expected,
        maxTtlMs: 300_000,
        maxPendingPerCallSite: 1,
        maxPendingPerAudience: 3,
      });
      expect(policy).not.toHaveProperty("purpose");
    },
  );

  it.each(
    [
      [],
      ["operator.write"],
      ["operator.read", "operator.admin"],
      ["operator.read", "operator.approvals"],
      ["operator.read", "operator.questions"],
      ["operator.read", "operator.pairing"],
      ["operator.read", "operator.talk.secrets"],
      ["operator.read", "operator.read"],
    ].map((scopes) => ({ scopes })),
  )("refuses invalid requested scopes before the storage seam: $scopes", async ({ scopes }) => {
    await expect(
      issueRemoteControlUiPairingBootstrap({ ...input, scopes }, authority),
    ).rejects.toMatchObject({
      code: "invalid-options",
      message: expect.stringContaining("Pairing scopes"),
    });
  });

  it.each([
    { deviceId: "wrong-device" },
    { publicKey: "not-an-ed25519-key" },
    { displayName: "" },
    { displayName: "spoofed\nowner" },
    { displayName: "x".repeat(129) },
  ])("refuses invalid identity or display claims: %j", async (overrides) => {
    await expect(
      issueRemoteControlUiPairingBootstrap({ ...input, ...overrides }, authority),
    ).rejects.toMatchObject({
      code: "invalid-options",
    });
  });

  it("refuses valid issuance and cancellation instead of falling back to ordinary bootstrap", async () => {
    await expect(issueRemoteControlUiPairingBootstrap(input, authority)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("durable audience-bound device storage"),
    });
    await expect(
      cancelRemoteControlUiPairingBootstrap("synthetic-enrollment", authority.assertCurrent),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("checks caller authority and cancellation before considering enrollment", async () => {
    const retired = new Error("synthetic grant retired");
    const stale = {
      ...authority,
      assertCurrent: () => {
        throw retired;
      },
    };
    await expect(issueRemoteControlUiPairingBootstrap(input, stale)).rejects.toBe(retired);
    await expect(
      cancelRemoteControlUiPairingBootstrap("synthetic-enrollment", stale.assertCurrent),
    ).rejects.toBe(retired);
    await expect(
      issueRemoteControlUiPairingBootstrap(
        { ...input, signal: AbortSignal.abort(retired) },
        authority,
      ),
    ).rejects.toBe(retired);
  });
});
