// Session target tests cover target resolution for cron-created sessions.
import { describe, expect, it } from "vitest";
import {
  resolveCronDeliverySessionKey,
  resolveCronSessionTargetSessionKey,
} from "./session-target.js";

describe("cron session target helpers", () => {
  it("extracts and trims persistent session targets", () => {
    expect(resolveCronSessionTargetSessionKey("session: agent:main:telegram:direct:123 ")).toBe(
      "agent:main:telegram:direct:123",
    );
  });

  it("rejects null bytes in persistent session targets", () => {
    expect(() => resolveCronSessionTargetSessionKey("session:bad\0id")).toThrow(
      "invalid cron sessionTarget session id",
    );
  });

  it("prefers sessionTarget over creator sessionKey for delivery", () => {
    expect(
      resolveCronDeliverySessionKey({
        sessionTarget: "session:agent:main:telegram:direct:123",
        sessionKey: "agent:main:telegram:group:ops:sender:123",
      }),
    ).toBe("agent:main:telegram:direct:123");
  });

  it("falls back to trimmed creator sessionKey for delivery", () => {
    expect(
      resolveCronDeliverySessionKey({
        sessionTarget: "isolated",
        sessionKey: " agent:main:telegram:group:ops:sender:123 ",
      }),
    ).toBe("agent:main:telegram:group:ops:sender:123");
  });
});
