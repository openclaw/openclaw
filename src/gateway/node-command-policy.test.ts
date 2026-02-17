import { describe, expect, it } from "vitest";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";

describe("resolveNodeCommandAllowlist", () => {
  it("includes iOS service commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "ios 26.0",
        deviceFamily: "iPhone",
      },
    );

    expect(allow.has("device.info")).toBe(true);
    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("system.notify")).toBe(true);
    expect(allow.has("contacts.search")).toBe(true);
    expect(allow.has("calendar.events")).toBe(true);
    expect(allow.has("reminders.list")).toBe(true);
    expect(allow.has("photos.latest")).toBe(true);
    expect(allow.has("motion.activity")).toBe(true);

    for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
      expect(allow.has(cmd)).toBe(false);
    }
  });

  it("can explicitly allow dangerous commands via allowCommands", () => {
    const allow = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            allowCommands: ["camera.snap", "screen.record"],
          },
        },
      },
      { platform: "ios", deviceFamily: "iPhone" },
    );
    expect(allow.has("camera.snap")).toBe(true);
    expect(allow.has("screen.record")).toBe(true);
    expect(allow.has("camera.clip")).toBe(false);
  });
});
