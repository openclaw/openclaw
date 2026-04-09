import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadHostEnvSecurityPolicy } from "./host-env-security-policy.js";

function parseSwiftStringArray(source: string, marker: string): string[] {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedMarker}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Failed to parse Swift array for marker: ${marker}`);
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function sortUnique(values: string[]): string[] {
  return Array.from(new Set(values)).toSorted((a, b) => a.localeCompare(b));
}

describe("host env security policy parity", () => {
  it("keeps generated macOS host env policy in sync with shared JSON policy", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
    const generatedSwiftPath = path.join(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSecurityPolicy.generated.swift",
    );
    const sanitizerSwiftPath = path.join(
      repoRoot,
      "apps/macos/Sources/OpenClaw/HostEnvSanitizer.swift",
    );

    const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const policy = loadHostEnvSecurityPolicy(rawPolicy);
    const generatedSource = fs.readFileSync(generatedSwiftPath, "utf8");
    const sanitizerSource = fs.readFileSync(sanitizerSwiftPath, "utf8");

    const swiftBlockedKeys = parseSwiftStringArray(generatedSource, "static let blockedKeys");
    const swiftBlockedOverrideKeys = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverrideKeys",
    );
    const swiftBlockedOverridePrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedOverridePrefixes",
    );
    const swiftBlockedPrefixes = parseSwiftStringArray(
      generatedSource,
      "static let blockedPrefixes",
    );

    expect(swiftBlockedKeys).toEqual(policy.blockedKeys);
    expect(swiftBlockedOverrideKeys).toEqual(policy.blockedOverrideKeys ?? []);
    expect(swiftBlockedOverridePrefixes).toEqual(policy.blockedOverridePrefixes ?? []);
    expect(swiftBlockedPrefixes).toEqual(policy.blockedPrefixes);

    expect(sanitizerSource).toContain(
      "private static let blockedKeys = HostEnvSecurityPolicy.blockedKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverrideKeys = HostEnvSecurityPolicy.blockedOverrideKeys",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedOverridePrefixes = HostEnvSecurityPolicy.blockedOverridePrefixes",
    );
    expect(sanitizerSource).toContain(
      "private static let blockedPrefixes = HostEnvSecurityPolicy.blockedPrefixes",
    );
  });

  it("derives inherited and override lists from explicit policy buckets", () => {
    const repoRoot = process.cwd();
    const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
    const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const policy = loadHostEnvSecurityPolicy(rawPolicy);

    expect(policy.blockedKeys).toEqual(sortUnique([...policy.blockedEverywhereKeys]));
    expect(policy.blockedOverrideKeys).toEqual(sortUnique([...policy.blockedOverrideOnlyKeys]));
  });
});
