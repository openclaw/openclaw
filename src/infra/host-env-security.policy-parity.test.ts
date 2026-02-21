import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type HostEnvSecurityPolicy = {
  blockedKeys: string[];
  blockedPrefixes: string[];
};

function parseSwiftStringArray(source: string, marker: string): string[] {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedMarker}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Failed to parse Swift array for marker: ${marker}`);
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

describe("host env security policy parity", () => {
  it("keeps macOS HostEnvSanitizer lists in sync with shared JSON policy", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
    const swiftPath = path.join(repoRoot, "apps/macos/Sources/OpenClaw/HostEnvSanitizer.swift");

    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as HostEnvSecurityPolicy;
    const swiftSource = fs.readFileSync(swiftPath, "utf8");

    const swiftBlockedKeys = parseSwiftStringArray(swiftSource, "private static let blockedKeys");
    const swiftBlockedPrefixes = parseSwiftStringArray(
      swiftSource,
      "private static let blockedPrefixes",
    );

    expect(swiftBlockedKeys).toEqual(policy.blockedKeys);
    expect(swiftBlockedPrefixes).toEqual(policy.blockedPrefixes);
  });
});
