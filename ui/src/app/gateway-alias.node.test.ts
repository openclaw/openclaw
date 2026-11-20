// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { readGatewayAlias, saveGatewayAlias } from "./gateway-alias.ts";

const office = "wss://gateway.example.test/office";
const home = "wss://gateway.example.test/home";

describe("Gateway browser aliases", () => {
  beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
  afterEach(() => vi.unstubAllGlobals());

  it("stores only the label, scopes it by Gateway address, and clears only that Gateway", () => {
    localStorage.setItem("other-browser-preference", "unchanged");
    expect(saveGatewayAlias(office + "/?route=example", "  Escritório 🦞  ")).toBeNull();
    expect(saveGatewayAlias(home, "Home Mac")).toBeNull();
    expect(readGatewayAlias(office)).toBe("Escritório 🦞");
    expect(readGatewayAlias("wss://another.example.test/office")).toBeUndefined();
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    expect(keys.join("\n")).not.toContain("route=example");
    expect(saveGatewayAlias(office, "  ")).toBeNull();
    expect(readGatewayAlias(office)).toBeUndefined();
    expect(readGatewayAlias(home)).toBe("Home Mac");
    expect(localStorage.getItem("other-browser-preference")).toBe("unchanged");
  });

  it("rejects oversized names and leaves the existing name in place on failed writes", () => {
    const existing = "🙂".repeat(64);
    expect(saveGatewayAlias(office, existing)).toBeNull();
    expect(saveGatewayAlias(office, existing + "x")).toBe("too-long");
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    expect(saveGatewayAlias(office, "New name")).toBe("storage-unavailable");
    expect(readGatewayAlias(office)).toBe(existing);
    vi.stubGlobal("localStorage", undefined);
    expect(readGatewayAlias(office)).toBeUndefined();
    expect(saveGatewayAlias(office, "New name")).toBe("storage-unavailable");
  });
});
