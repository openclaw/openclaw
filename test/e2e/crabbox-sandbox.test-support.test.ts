import { describe, expect, it } from "vitest";
import {
  assertLiveCrabboxClassSizing,
  resolveLiveCrabboxSandboxConfig,
} from "./crabbox-sandbox.test-support.js";

describe("Crabbox sandbox live sizing", () => {
  it("defaults the lightweight lifecycle scenario to the tiny class", () => {
    expect(resolveLiveCrabboxSandboxConfig({})).toMatchObject({
      class: "tiny",
      binary: "crabbox",
      ttl: "30m",
      idleTimeout: "15m",
    });
  });

  it("preserves explicit test selections without selecting a provider or architecture", () => {
    expect(
      resolveLiveCrabboxSandboxConfig({
        OPENCLAW_E2E_CRABBOX_PROVIDER: "aws",
        OPENCLAW_E2E_CRABBOX_CLASS: "standard",
        OPENCLAW_E2E_CRABBOX_BINARY: "/opt/tools/crabbox",
        CRABBOX_ARCH: "arm64",
        CRABBOX_DEFAULT_CLASS: "beast",
      }),
    ).toEqual({
      provider: "aws",
      class: "standard",
      binary: "/opt/tools/crabbox",
      ttl: "30m",
      idleTimeout: "15m",
    });
  });

  it("admits class-based sizing before provisioning", () => {
    expect(() => assertLiveCrabboxClassSizing('{"serverTypeExplicit":false}')).not.toThrow();
  });

  it.each([
    '{"serverTypeExplicit":true,"serverType":"private-instance"}',
    "{}",
    "null",
    '{"serverTypeExplicit":"false"}',
    "invalid-json",
  ])("rejects inherited exact types or unverified sizing (%s)", (config) => {
    expect(() => assertLiveCrabboxClassSizing(config)).toThrow(
      /clear CRABBOX_SERVER_TYPE and explicit server type settings/i,
    );
    expect(() => assertLiveCrabboxClassSizing(config)).not.toThrow(/private-instance/);
  });
});
