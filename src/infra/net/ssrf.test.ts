import { describe, expect, it } from "vitest";
import { normalizeFingerprint } from "../tls/fingerprint.js";
import { isBlockedHostnameOrIp, isPrivateIpAddress } from "./ssrf.js";

const privateIpCases = [
  "198.51.100.42",
  "203.0.113.10",
  "192.0.0.8",
  "192.0.2.1",
  "192.88.99.1",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  "::ffff:127.0.0.1",
  "64:ff9b::198.51.100.42",
  "0:0:0:0:0:ffff:7f00:1",
  "0000:0000:0000:0000:0000:ffff:7f00:0001",
  "::127.0.0.1",
  "0:0:0:0:0:0:7f00:1",
  "[0:0:0:0:0:ffff:7f00:1]",
  "::ffff:169.254.169.254",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "64:ff9b::127.0.0.1",
  "64:ff9b::169.254.169.254",
  "64:ff9b:1::192.168.1.1",
  "64:ff9b:1::10.0.0.1",
  "2002:7f00:0001::",
  "2002:a9fe:a9fe::",
  "2001:0000:0:0:0:0:80ff:fefe",
  "2001:0000:0:0:0:0:3f57:fefe",
  "::",
  "::1",
  "fe80::1%lo0",
  "fd00::1",
  "fec0::1",
  "2001:db8:1234::5efe:127.0.0.1",
  "2001:db8:1234:1:200:5efe:7f00:1",
];

const publicIpCases = [
  "93.184.216.34",
  "198.17.255.255",
  "198.18.0.1",
  "198.18.0.153",
  "198.19.255.254",
  "198.20.0.1",
  "2002:c612:0001::",
  "198.51.99.1",
  "198.51.101.1",
  "203.0.112.1",
  "203.0.114.1",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "::ffff:198.18.0.1",
  "2001:db8::1",
  "64:ff9b::8.8.8.8",
  "64:ff9b:1::8.8.8.8",
  "2002:0808:0808::",
  "2001:0000:0:0:0:0:f7f7:f7f7",
  "2001:db8:1234::5efe:8.8.8.8",
  "2001:db8:1234:1:1111:5efe:7f00:1",
];

const malformedIpv6Cases = ["::::", "2001:db8::gggg"];
const unsupportedLegacyIpv4Cases = [
  "0177.0.0.1",
  "0x7f.0.0.1",
  "127.1",
  "2130706433",
  "0x7f000001",
  "017700000001",
  "8.8.2056",
  "0x08080808",
  "08.0.0.1",
  "0x7g.0.0.1",
  "127..0.1",
  "999.1.1.1",
];

const nonIpHostnameCases = ["example.com", "abc.123.example", "1password.com", "0x.example.com"];

describe("ssrf ip classification", () => {
  it("classifies blocked ip literals as private", () => {
    const blockedCases = [...privateIpCases, ...malformedIpv6Cases, ...unsupportedLegacyIpv4Cases];
    for (const address of blockedCases) {
      expect(isPrivateIpAddress(address)).toBe(true);
    }
  });

  it("classifies public ip literals as non-private", () => {
    for (const address of publicIpCases) {
      expect(isPrivateIpAddress(address)).toBe(false);
    }
  });

  it("does not treat hostnames as ip literals", () => {
    for (const hostname of nonIpHostnameCases) {
      expect(isPrivateIpAddress(hostname)).toBe(false);
    }
  });
});

describe("normalizeFingerprint", () => {
  it("strips sha256 prefixes and separators", () => {
    expect(normalizeFingerprint("sha256:AA:BB:cc")).toBe("aabbcc");
    expect(normalizeFingerprint("SHA-256 11-22-33")).toBe("112233");
    expect(normalizeFingerprint("aa:bb:cc")).toBe("aabbcc");
  });
});

describe("isBlockedHostnameOrIp", () => {
  it("blocks localhost.localdomain and metadata hostname aliases", () => {
    expect(isBlockedHostnameOrIp("localhost.localdomain")).toBe(true);
    expect(isBlockedHostnameOrIp("metadata.google.internal")).toBe(true);
  });

  it("blocks private transition addresses via shared IP classifier", () => {
    expect(isBlockedHostnameOrIp("2001:db8:1234::5efe:127.0.0.1")).toBe(true);
    expect(isBlockedHostnameOrIp("2001:db8::1")).toBe(false);
  });

  it("allows RFC2544 benchmark range (used by Telegram) but blocks adjacent special-use ranges", () => {
    expect(isBlockedHostnameOrIp("198.18.0.1")).toBe(false);
    expect(isBlockedHostnameOrIp("198.18.0.153")).toBe(false);
    expect(isBlockedHostnameOrIp("198.19.255.254")).toBe(false);
    expect(isBlockedHostnameOrIp("198.20.0.1")).toBe(false);
    expect(isBlockedHostnameOrIp("198.51.100.1")).toBe(true);
    expect(isBlockedHostnameOrIp("203.0.113.1")).toBe(true);
  });

  it("blocks legacy IPv4 literal representations", () => {
    expect(isBlockedHostnameOrIp("0177.0.0.1")).toBe(true);
    expect(isBlockedHostnameOrIp("8.8.2056")).toBe(true);
    expect(isBlockedHostnameOrIp("127.1")).toBe(true);
    expect(isBlockedHostnameOrIp("2130706433")).toBe(true);
  });
});
