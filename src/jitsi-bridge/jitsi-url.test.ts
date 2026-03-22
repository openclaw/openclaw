import { describe, expect, it } from "vitest";
import { buildJitsiRoomUrl, createRoomId, slugifyRoomId } from "./jitsi-url.js";

describe("jitsi-url", () => {
  it("slugifies room names", () => {
    expect(slugifyRoomId(" Meeting Assistant Live Briefing ")).toBe(
      "meeting-assistant-live-briefing",
    );
  });

  it("creates time-based room ids", () => {
    expect(createRoomId("Quarterly Briefing")).toMatch(/^quarterly-briefing-\d{14}$/);
  });

  it("builds jitsi urls with display name fragments", () => {
    expect(
      buildJitsiRoomUrl({
        baseUrl: "https://meet.jit.si/",
        roomId: "meeting-assistant-123",
        displayName: "Meeting Assistant",
      }),
    ).toContain('userInfo.displayName="Meeting Assistant"');
  });
});
