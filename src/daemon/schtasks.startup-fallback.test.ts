import { describe, expect, it } from "vitest";

describe("Windows startup fallback", () => {
  it("keeps startup script samples conflict-marker free", () => {
    const startupScriptLines = [
      "@echo off",
      'set "OPENCLAW_GATEWAY_PORT=18789"',
      'start "" /min cmd.exe /d /c gateway.cmd',
    ];
    const hasMarker = startupScriptLines.some((line) => /^<{7}|^={7}$|^>{7}/.test(line));
    expect(hasMarker).toBe(false);
  });
});
