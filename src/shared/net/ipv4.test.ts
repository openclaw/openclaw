import { describe, expect, it } from "vitest";
import { validateIPv4AddressInput } from "./ipv4.js";

describe("validateIPv4AddressInput", () => {
  it("returns undefined for valid addresses", () => {
    expect(validateIPv4AddressInput("192.168.1.100")).toBeUndefined();
    expect(validateIPv4AddressInput("0.0.0.0")).toBeUndefined();
    expect(validateIPv4AddressInput("255.255.255.255")).toBeUndefined();
    expect(validateIPv4AddressInput("10.0.0.1")).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(validateIPv4AddressInput("  192.168.1.1  ")).toBeUndefined();
  });

  it("rejects empty/undefined input", () => {
    expect(validateIPv4AddressInput(undefined)).toBeDefined();
    expect(validateIPv4AddressInput("")).toBeDefined();
  });

  it("rejects wrong number of octets", () => {
    expect(validateIPv4AddressInput("192.168.1")).toBeDefined();
    expect(validateIPv4AddressInput("192.168.1.1.1")).toBeDefined();
  });

  it("rejects out-of-range octets", () => {
    expect(validateIPv4AddressInput("256.0.0.1")).toBeDefined();
    expect(validateIPv4AddressInput("0.0.0.999")).toBeDefined();
  });

  it("rejects leading zeros", () => {
    expect(validateIPv4AddressInput("192.168.01.1")).toBeDefined();
  });

  it("rejects non-numeric octets", () => {
    expect(validateIPv4AddressInput("abc.0.0.1")).toBeDefined();
  });
});
