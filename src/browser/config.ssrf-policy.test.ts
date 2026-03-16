import { describe, expect, it } from "vitest";
import { resolveBrowserSsrFPolicy } from "./config.js";

describe("resolveBrowserSsrFPolicy", () => {
  it("defaults to trusted-network mode when no config is provided", () => {
    expect(resolveBrowserSsrFPolicy(undefined)?.dangerouslyAllowPrivateNetwork).toBe(true);
  });

  it("defaults to trusted-network mode when ssrfPolicy is absent", () => {
    expect(resolveBrowserSsrFPolicy({})?.dangerouslyAllowPrivateNetwork).toBe(true);
  });

  it("allows private network by default (trusted-network mode)", () => {
    const policy = resolveBrowserSsrFPolicy({ ssrfPolicy: {} });
    expect(policy?.dangerouslyAllowPrivateNetwork).toBe(true);
  });

  it("respects explicit allowPrivateNetwork: false", () => {
    const policy = resolveBrowserSsrFPolicy({
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(policy?.dangerouslyAllowPrivateNetwork).toBeUndefined();
  });

  it("passes through allowedHostnames", () => {
    const policy = resolveBrowserSsrFPolicy({
      ssrfPolicy: { allowedHostnames: ["example.com", "internal.local"] },
    });
    expect(policy?.allowedHostnames).toEqual(["example.com", "internal.local"]);
  });

  it("filters empty strings from allowedHostnames", () => {
    const policy = resolveBrowserSsrFPolicy({
      ssrfPolicy: { allowedHostnames: ["example.com", "", "  "] },
    });
    expect(policy?.allowedHostnames).toEqual(["example.com"]);
  });
});
