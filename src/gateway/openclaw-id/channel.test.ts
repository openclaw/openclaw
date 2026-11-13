import { describe, expect, it } from "vitest";
import { resolveOpenClawIdClientChannel } from "./channel.js";

describe("OpenClaw ID client channel", () => {
  it("treats only handshake-attested direct loopback as the local operator", () => {
    expect(resolveOpenClawIdClientChannel({ internal: { isLocalClient: true } })).toBe(
      "local_operator",
    );
    expect(resolveOpenClawIdClientChannel({ internal: {} })).toBeUndefined();
    expect(resolveOpenClawIdClientChannel(undefined)).toBeUndefined();
  });

  // Spec section 11 #7: relayed traffic arrives on the local host but is never direct loopback.
  it("never lets a relayed client act as the local operator", () => {
    expect(
      resolveOpenClawIdClientChannel({
        internal: { isLocalClient: true, openclawIdPeerKey: `iroh:${"ab".repeat(32)}` },
      }),
    ).toBe("tunnel");
  });
});
