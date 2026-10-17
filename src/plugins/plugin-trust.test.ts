import { describe, expect, it } from "vitest";
import { PluginTrustRefusalError, type PluginTrust } from "./plugin-trust.js";

function refusal(reason: PluginTrust["reason"]): string {
  return new PluginTrustRefusalError({
    pluginId: "demo",
    source: "/tmp/demo/index.js",
    trust: { reason, registryPath: null, origin: "global" },
  }).message;
}

describe("plugin trust refusal remedy", () => {
  it("does not send third-party npm installs to the official source", () => {
    const message = refusal("third-party-npm");
    expect(message).toContain("reason=third-party-npm");
    expect(message).toContain("cannot dispatch hook agent turns");
    expect(message).not.toContain("Reinstall from the official");
  });

  it("keeps the reinstall remedy for inconsistent provenance", () => {
    expect(refusal("provenance-invalid")).toContain("Reinstall from the official");
  });
});
