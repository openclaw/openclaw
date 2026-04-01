import { describe, expect, it } from "vitest";
import { diffApprovedNodeCommands, normalizeDeclaredNodeCommands } from "./node-command-policy.js";

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

  it("reports command drift against the approved node command set", () => {
    const allowlist = new Set(["canvas.snapshot", "system.run", "system.which"]);
    expect(
      diffApprovedNodeCommands({
        declaredCommands: ["canvas.snapshot", "system.run"],
        approvedCommands: ["canvas.snapshot", "system.which"],
        allowlist,
      }),
    ).toEqual({
      declared: ["canvas.snapshot", "system.run"],
      approved: ["canvas.snapshot", "system.which"],
      missingApproved: ["system.run"],
      extraApproved: ["system.which"],
      effective: ["canvas.snapshot"],
      needsRepair: true,
    });
  });
});
