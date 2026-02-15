import { describe, expect, it } from "vitest";
import { isPrivateIpAddress } from "./ssrf.js";

describe("ssrf ip classification", () => {
  it("treats IPv4-mapped and IPv4-compatible IPv6 loopback as private", () => {
    expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isPrivateIpAddress("0000:0000:0000:0000:0000:ffff:7f00:0001")).toBe(true);
    expect(isPrivateIpAddress("::127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("0:0:0:0:0:0:7f00:1")).toBe(true);
    expect(isPrivateIpAddress("[0:0:0:0:0:ffff:7f00:1]")).toBe(true);
  });

  it("treats IPv4-mapped metadata/link-local as private", () => {
    expect(isPrivateIpAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIpAddress("0:0:0:0:0:ffff:a9fe:a9fe")).toBe(true);
  });

  it("treats common IPv6 private/internal ranges as private", () => {
    expect(isPrivateIpAddress("::")).toBe(true);
    expect(isPrivateIpAddress("::1")).toBe(true);
    expect(isPrivateIpAddress("fe80::1%lo0")).toBe(true);
    expect(isPrivateIpAddress("fd00::1")).toBe(true);
    expect(isPrivateIpAddress("fec0::1")).toBe(true);
  });

  it("does not classify public IPs as private", () => {
    expect(isPrivateIpAddress("93.184.216.34")).toBe(false);
    expect(isPrivateIpAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIpAddress("2001:db8::1")).toBe(false);
  });
});
