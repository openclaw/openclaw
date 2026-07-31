import { describe, expect, it } from "vitest";
import { resolveSessionRoutingContract } from "./main-session.js";

describe("session routing contract", () => {
  it("changes when a sole main roster becomes ownerless multi-agent", () => {
    const soleMain = resolveSessionRoutingContract({ agents: { entries: { main: {} } } });
    const ownerlessMulti = resolveSessionRoutingContract({
      agents: { entries: { main: {}, research: {} } },
    });

    expect(soleMain).toContain("selected:main");
    expect(ownerlessMulti).toContain("absent");
    expect(ownerlessMulti).not.toBe(soleMain);
  });
});
