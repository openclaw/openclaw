import { describe, expect, it } from "vitest";
import { resolveRealtimeSenderIsOwner } from "./session.js";

describe("resolveRealtimeSenderIsOwner", () => {
  it("allows only owner-equivalent realtime brain auth", () => {
    expect(resolveRealtimeSenderIsOwner("token", false)).toBe(true);
    expect(resolveRealtimeSenderIsOwner("password", false)).toBe(true);
    expect(resolveRealtimeSenderIsOwner("none", true)).toBe(true);

    expect(resolveRealtimeSenderIsOwner("none", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("trusted-proxy", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("tailscale", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("device-token", false)).toBe(false);
  });
});
