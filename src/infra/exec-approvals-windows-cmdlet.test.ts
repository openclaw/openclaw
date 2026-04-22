import { describe, expect, it } from "vitest";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import { evaluateShellAllowlist, resolveAllowAlwaysPatterns, resolveSafeBins } from "./exec-approvals.js";

// Stable PowerShell path used for assertions.  The fallback resolves via
// resolvePowerShellPath(); on CI or dev machines the resolved path varies,
// so we call the same function to get the value tests will see.
import { resolvePowerShellPath } from "./executable-path.js";

const WINDOWS_PLATFORM = "win32";
const safeBins = resolveSafeBins(undefined);

function evalWindows(command: string, allowlist: Array<{ pattern: string; argPattern?: string }>) {
  return evaluateShellAllowlist({
    command,
    allowlist,
    safeBins,
    cwd: process.cwd(),
    platform: WINDOWS_PLATFORM,
  });
}

describe("windows powershell cmdlet allowlist fallback", () => {
  it("matches a bare cmdlet against a powershell allowlist entry with argPattern", () => {
    const psPath = resolvePowerShellPath();
    // Build the argPattern that collectAllowAlwaysPatterns would generate:
    // argv.slice(1) of syntheticArgv [psPath, "Get-ChildItem", "-LiteralPath", "C:\\Users\\foo"]
    // = ["Get-ChildItem", "-LiteralPath", "C:\\Users\\foo"]
    // joined with \x00 and regex-escaped.  Note: - is not a regex metachar, so not escaped.
    const argPattern = `^Get-ChildItem\x00-LiteralPath\x00C:\\\\Users\\\\foo\x00$`;

    const result = evalWindows("Get-ChildItem -LiteralPath C:\\Users\\foo", [
      { pattern: psPath, argPattern },
    ]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("rejects a bare cmdlet when argPattern does not include the cmdlet name", () => {
    const psPath = resolvePowerShellPath();
    // argPattern only matches args, not the cmdlet name — should NOT match
    const argPattern = `^-LiteralPath\x00C:\\\\Users\\\\foo\x00$`;

    const result = evalWindows("Get-ChildItem -LiteralPath C:\\Users\\foo", [
      { pattern: psPath, argPattern },
    ]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("rejects a bare cmdlet when no powershell entry exists in the allowlist", () => {
    const result = evalWindows("Get-ChildItem -LiteralPath C:\\Users\\foo", [
      { pattern: "/usr/bin/node" },
    ]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("matches a powershell-wrapped cmdlet after wrapper stripping", () => {
    const psPath = resolvePowerShellPath();
    const argPattern = `^Get-ChildItem\x00-LiteralPath\x00C:\\\\Users\\\\foo\x00$`;

    const result = evalWindows(
      'powershell -NoProfile -Command "Get-ChildItem -LiteralPath C:\\Users\\foo"',
      [{ pattern: psPath, argPattern }],
    );

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("matches a bare powershell path allowlist entry without argPattern (broad grant)", () => {
    const psPath = resolvePowerShellPath();

    const result = evalWindows("Get-ChildItem -LiteralPath C:\\Users\\foo", [
      { pattern: psPath },
    ]);

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("generates allow-always pattern with cmdlet name in argPattern", () => {
    const psPath = resolvePowerShellPath();
    const analysis = evalWindows("Get-ChildItem -LiteralPath C:\\Users\\foo", []);

    const patterns = resolveAllowAlwaysPatterns({
      segments: analysis.segments,
      cwd: process.cwd(),
      platform: WINDOWS_PLATFORM,
    });

    expect(patterns.length).toBe(1);
    expect(patterns[0]).toBe(psPath);

    // Verify that the full pattern entries include an argPattern with the cmdlet name
    const entries = resolveAllowAlwaysPatternEntries({
      segments: analysis.segments,
      cwd: process.cwd(),
      platform: WINDOWS_PLATFORM,
    });

    expect(entries.length).toBe(1);
    expect(entries[0].pattern).toBe(psPath);
    expect(entries[0].argPattern).toBeDefined();
    // The argPattern should match the cmdlet name
    expect(entries[0].argPattern).toContain("Get-ChildItem");
  });

  it("does not apply cmdlet fallback on non-windows platforms", () => {
    const result = evaluateShellAllowlist({
      command: "Get-ChildItem -LiteralPath /home/foo",
      allowlist: [{ pattern: resolvePowerShellPath() }],
      safeBins,
      cwd: process.cwd(),
      platform: "linux",
    });

    expect(result.allowlistSatisfied).toBe(false);
  });
});
