import { describe, expect, it } from "vitest";
import { projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields.js";

describe("projectSafeChannelAccountSnapshotFields", () => {
  it("omits webhook and public-key style fields from generic snapshots", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config",
      signingSecretStatus: "configured_unavailable",
      webhookUrl: "https://example.com/webhook", // pragma: allowlist secret (fixture URL)
      webhookPath: "/webhook", // pragma: allowlist secret (fixture path)
      audienceType: "project-number",
      audience: "1234567890", // pragma: allowlist secret (fixture audience)
      publicKey: "pk_live_123", // pragma: allowlist secret (fixture key)
    });

    expect(snapshot).toEqual({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config",
      signingSecretStatus: "configured_unavailable",
    });
  });
});
