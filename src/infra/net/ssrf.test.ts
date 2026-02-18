import { describe, expect, it } from "vitest";
import { normalizeFingerprint } from "../tls/fingerprint.js";
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

  it("treats private IPv4 embedded in NAT64 prefixes as private", () => {
    expect(isPrivateIpAddress("64:ff9b::127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("64:ff9b::169.254.169.254")).toBe(true);
    expect(isPrivateIpAddress("64:ff9b:1::192.168.1.1")).toBe(true);
    expect(isPrivateIpAddress("64:ff9b:1::10.0.0.1")).toBe(true);
  });

  it("treats private IPv4 embedded in 6to4 and Teredo prefixes as private", () => {
    expect(isPrivateIpAddress("2002:7f00:0001::")).toBe(true);
    expect(isPrivateIpAddress("2002:a9fe:a9fe::")).toBe(true);
    expect(isPrivateIpAddress("2001:0000:0:0:0:0:80ff:fefe")).toBe(true);
    expect(isPrivateIpAddress("2001:0000:0:0:0:0:3f57:fefe")).toBe(true);
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
    expect(isPrivateIpAddress("64:ff9b::8.8.8.8")).toBe(false);
    expect(isPrivateIpAddress("64:ff9b:1::8.8.8.8")).toBe(false);
    expect(isPrivateIpAddress("2002:0808:0808::")).toBe(false);
    expect(isPrivateIpAddress("2001:0000:0:0:0:0:f7f7:f7f7")).toBe(false);
  });

  it("fails closed for malformed IPv6 input", () => {
    expect(isPrivateIpAddress("::::")).toBe(true);
    expect(isPrivateIpAddress("2001:db8::gggg")).toBe(true);
  });
});

describe("normalizeFingerprint", () => {
  it("strips sha256 prefixes and separators", () => {
    expect(normalizeFingerprint("sha256:AA:BB:cc")).toBe("aabbcc");
    expect(normalizeFingerprint("SHA-256 11-22-33")).toBe("112233");
    expect(normalizeFingerprint("aa:bb:cc")).toBe("aabbcc");
  });
});
