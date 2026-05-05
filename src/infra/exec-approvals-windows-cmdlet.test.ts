import { describe, expect, it } from "vitest";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import { evaluateShellAllowlist, resolveAllowAlwaysPatterns, resolveSafeBins } from "./exec-approvals.js";

// Stable PowerShell path used for assertions.  The fallback resolves via
// resolvePowerShellPath(); on CI or dev machines the resolved path varies,
// so we call the same function to get the value tests will see.
import { resolvePowerShellPath } from "./executable-path.js";

const WINDOWS_PLATFORM = "win32";
const safeBins = resolveSafeBins(undefined);
const CMD = "Get-ChildItem -LiteralPath C:\\Users\\foo";

function evalWindows(command: string, allowlist: Array<{ pattern: string; argPattern?: string }>) {
  return evaluateShellAllowlist({
    command,
    allowlist,
    safeBins,
    cwd: process.cwd(),
    platform: WINDOWS_PLATFORM,
  });
}

/** Derive the allow-always entry that production code would generate for a command. */
function deriveAllowAlwaysEntry(command: string) {
  const analysis = evalWindows(command, []);
  const entries = resolveAllowAlwaysPatternEntries({
    segments: analysis.segments,
    cwd: process.cwd(),
    platform: WINDOWS_PLATFORM,
  });
  expect(entries.length).toBe(1);
  return entries[0];
}

describe("windows powershell cmdlet allowlist fallback", () => {
  it("matches a bare cmdlet against its derived allow-always entry", () => {
    const entry = deriveAllowAlwaysEntry(CMD);

    const result = evalWindows(CMD, [entry]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("rejects a bare cmdlet when argPattern does not include the cmdlet name", () => {
    const entry = deriveAllowAlwaysEntry(CMD);
    // Strip the cmdlet name from the argPattern — should no longer match
    const tampered = { ...entry, argPattern: entry.argPattern!.replace("Get-ChildItem", "Remove-Item") };

    const result = evalWindows(CMD, [tampered]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("rejects a bare cmdlet when no powershell entry exists in the allowlist", () => {
    const result = evalWindows(CMD, [{ pattern: "/usr/bin/node" }]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("matches a powershell-wrapped cmdlet after wrapper stripping", () => {
    const entry = deriveAllowAlwaysEntry(CMD);

    const result = evalWindows(
      'powershell -NoProfile -Command "Get-ChildItem -LiteralPath C:\\Users\\foo"',
      [entry],
    );

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("matches a bare powershell path allowlist entry without argPattern (broad grant)", () => {
    const psPath = resolvePowerShellPath();

    const result = evalWindows(CMD, [{ pattern: psPath }]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("generates allow-always pattern with cmdlet name in argPattern", () => {
    const psPath = resolvePowerShellPath();
    const analysis = evalWindows(CMD, []);

    const patterns = resolveAllowAlwaysPatterns({
      segments: analysis.segments,
      cwd: process.cwd(),
      platform: WINDOWS_PLATFORM,
    });

    expect(patterns.length).toBe(1);
    expect(patterns[0]).toBe(psPath);

    const entries = resolveAllowAlwaysPatternEntries({
      segments: analysis.segments,
      cwd: process.cwd(),
      platform: WINDOWS_PLATFORM,
    });

    expect(entries.length).toBe(1);
    expect(entries[0].pattern).toBe(psPath);
    expect(entries[0].argPattern).toBeDefined();
    expect(entries[0].argPattern).toContain("Get-ChildItem");
  });

  it("does not apply cmdlet fallback on non-windows platforms", () => {
    const result = evaluateShellAllowlist({
      command: CMD,
      allowlist: [{ pattern: resolvePowerShellPath() }],
      safeBins,
      cwd: process.cwd(),
      platform: "linux",
    });

    expect(result.allowlistSatisfied).toBe(false);
  });
});
