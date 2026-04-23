import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackEquivalentBind } from "./gateway-bind.js";

describe("isLoopbackEquivalentBind", () => {
  afterEach(() => {
    vi.doUnmock("../gateway/net.js");
    vi.resetModules();
  });

  it('returns true for bind="loopback"', () => {
    expect(isLoopbackEquivalentBind({ bind: "loopback", customBindHost: undefined })).toBe(true);
  });

  it('returns true for bind="custom" with loopback IPv4 customBindHost', () => {
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "127.0.0.1" })).toBe(true);
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "127.0.0.2" })).toBe(true);
  });

  it('returns false for bind="custom" with a non-loopback IPv4 customBindHost', () => {
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "192.168.1.10" })).toBe(
      false,
    );
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "0.0.0.0" })).toBe(false);
  });

  it('returns false for bind="custom" with IPv6 loopback (::1) because the runtime resolver rejects IPv6 here', () => {
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "::1" })).toBe(false);
  });

  it('returns false for bind="custom" with a missing or malformed customBindHost', () => {
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: undefined })).toBe(false);
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "not-an-ip" })).toBe(false);
    expect(isLoopbackEquivalentBind({ bind: "custom", customBindHost: "" })).toBe(false);
  });

  it('returns false for bind="lan", "tailnet", and unknown strings', () => {
    expect(isLoopbackEquivalentBind({ bind: "lan", customBindHost: undefined })).toBe(false);
    expect(isLoopbackEquivalentBind({ bind: "tailnet", customBindHost: undefined })).toBe(false);
    expect(isLoopbackEquivalentBind({ bind: "made-up", customBindHost: undefined })).toBe(false);
    expect(isLoopbackEquivalentBind({ bind: undefined, customBindHost: undefined })).toBe(false);
  });

  it('returns true for bind="auto" on non-container hosts', async () => {
    vi.doMock("../gateway/net.js", () => ({
      isContainerEnvironment: () => false,
    }));
    const { isLoopbackEquivalentBind: reloaded } = await import("./gateway-bind.js");
    expect(reloaded({ bind: "auto", customBindHost: undefined })).toBe(true);
  });

  it('returns false for bind="auto" inside a container', async () => {
    vi.doMock("../gateway/net.js", () => ({
      isContainerEnvironment: () => true,
    }));
    const { isLoopbackEquivalentBind: reloaded } = await import("./gateway-bind.js");
    expect(reloaded({ bind: "auto", customBindHost: undefined })).toBe(false);
  });
});
