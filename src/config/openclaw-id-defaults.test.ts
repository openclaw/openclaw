import { describe, expect, it } from "vitest";
import { materializeRuntimeConfig } from "./materialize.js";

describe("OpenClaw ID staging defaults at runtime materialization", () => {
  it.each([undefined, false])("applies no defaults with enabled=%s", (enabled) => {
    const source = { gateway: { openclawId: { enabled } } };
    expect(materializeRuntimeConfig(source).gateway?.openclawId).toEqual({ enabled });
    expect(materializeRuntimeConfig({}).gateway?.openclawId).toBeUndefined();
  });

  it("fills absent fields without changing source config or explicit overrides", () => {
    const source = { gateway: { openclawId: { enabled: true, clientId: "custom-ui" } } };
    const runtime = materializeRuntimeConfig(source).gateway?.openclawId;
    expect(runtime).toEqual({
      enabled: true,
      clientId: "custom-ui",
      issuerUrl: "https://openclaw-id-staging.services-91b.workers.dev/api/auth",
      discoveryUrl: "https://openclaw-discovery-staging.services-91b.workers.dev",
      relayUrl: "https://relay.staging.crabd.xyz/",
      loaderDomain: "crabd.xyz",
    });
    expect(source.gateway.openclawId).toEqual({ enabled: true, clientId: "custom-ui" });
    const custom = {
      enabled: true,
      clientId: "custom-ui",
      issuerUrl: "https://id.example.test",
      discoveryUrl: "https://discovery.example.test",
      relayUrl: "https://relay.example.test/",
      loaderDomain: "claws.example.test",
    };
    expect(
      materializeRuntimeConfig({ gateway: { openclawId: custom } }).gateway?.openclawId,
    ).toEqual(custom);
  });
});
