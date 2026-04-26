import { describe, expect, it } from "vitest";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";

describe("gateway/node-command-policy", () => {
  it("normalizes declared node commands against the allowlist", () => {
    const allowlist = new Set(["canvas.snapshot", "system.run"]);
    expect(
      normalizeDeclaredNodeCommands({
        declaredCommands: [" canvas.snapshot ", "", "system.run", "system.run", "screen.record"],
        allowlist,
      }),
    ).toEqual(["canvas.snapshot", "system.run"]);
  });

  it("includes safe Windows companion command defaults (not only system.run)", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      { platform: "win32 10.0.17763", deviceFamily: "Windows" },
    );

    expect(allow.has("canvas.present")).toBe(true);
    expect(allow.has("camera.list")).toBe(true);
    expect(allow.has("location.get")).toBe(true);
    expect(allow.has("screen.snapshot")).toBe(true);
    expect(allow.has("device.info")).toBe(true);
    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("system.run")).toBe(true);
    for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
      expect(allow.has(cmd)).toBe(false);
    }
  });
});
