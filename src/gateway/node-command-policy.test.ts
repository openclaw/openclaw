import { describe, expect, it } from "vitest";
import {
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

  it("classifies Voice PE / ESP32-S3 nodes as embedded device diagnostics by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "esp32-s3",
        deviceFamily: "voice-pe",
      },
    );

    expect(allow.has("device.info")).toBe(true);
    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("debug.logs")).toBe(false);
    expect(allow.has("speaker.diagnostics")).toBe(false);
    expect(allow.has("system.run")).toBe(false);
    expect(allow.has("system.which")).toBe(false);
    expect(allow.has("camera.snap")).toBe(false);
  });

  it("still requires explicit allowCommands for Voice PE extended diagnostics", () => {
    const allow = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            allowCommands: ["debug.logs", "speaker.diagnostics"],
          },
        },
      },
      {
        platform: "esp32-s3",
        deviceFamily: "voice-pe",
      },
    );

    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("debug.logs")).toBe(true);
    expect(allow.has("speaker.diagnostics")).toBe(true);
    expect(allow.has("system.run")).toBe(false);
  });
});
