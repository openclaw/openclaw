// The link ceremony's caller guard (OCF-511) is checked at the durable write: an admin who loses
// their authority while the ceremony runs pins no root and admits no owner device.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ed25519SignerFromSeed,
  formatEd25519PublicKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { linkedClaw, memoryStore, TEST_K_SRV } from "./openclaw-id.test-support.js";

describe("link ceremony guard", () => {
  it("refuses the root write once the caller's authority is gone, then links for a current caller", async () => {
    let refusedWrite: unknown;
    const claw = await linkedClaw(undefined, async (authority, stateDir, input) => {
      const seed = fs.readFileSync(path.join(stateDir, "openclaw-id", "gateway.key"));
      const kGw = formatEd25519PublicKey((await ed25519SignerFromSeed(seed)).publicKey);
      const gone = () => {
        throw new Error("this connection changed");
      };
      refusedWrite = await authority
        .commitLink(input, "local_operator", { kSrv: TEST_K_SRV, kGw, guard: gone })
        .catch((error: unknown) => error);
      expect(authority.current()?.authority ?? null).toBeNull();
      return await authority.commitLink(input, "local_operator", {
        kSrv: TEST_K_SRV,
        kGw,
        guard: () => {},
      });
    });
    expect(refusedWrite).toBeInstanceOf(Error);
    expect(claw.authority.current()?.authority?.anchor.root_pub).toBeDefined();
  });

  it("refuses a stale caller's prepared hostname", async () => {
    const claw = await linkedClaw();
    const fresh = createOpenClawIdAuthority(memoryStore());
    await expect(
      fresh.prepareLink({
        kSrv: TEST_K_SRV,
        kGw: claw.prep.k_gw,
        hostname: "lab-e61zr.claws.example.test",
        guard: () => {
          throw new Error("this connection changed");
        },
      }),
    ).rejects.toThrow("this connection changed");
    expect(fresh.current()?.hostname).toBeUndefined();
  });
});
