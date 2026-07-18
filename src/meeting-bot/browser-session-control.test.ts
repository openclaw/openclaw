import { describe, expect, it, vi } from "vitest";
import { leaveMeetingWithBrowser } from "./browser-session-control.js";

describe("meeting browser leave ownership", () => {
  it("does not close a tab whose page belongs to another session", async () => {
    const buildLeaveScript = vi.fn(() => "() => '{}'");
    const deletedTabs: string[] = [];
    const result = await leaveMeetingWithBrowser({
      adapter: {
        browserLabel: "Test meeting",
        browser: {
          buildLeaveScript,
          parseLeaveResult: () => ({
            departed: false,
            sessionMatched: false,
            urlMatched: true,
          }),
        },
      } as never,
      callBrowser: async (request) => {
        if (request.path === "/tabs") {
          return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
        }
        if (request.path === "/act") {
          return { result: "{}" };
        }
        if (request.method === "DELETE") {
          deletedTabs.push(request.path);
          return {};
        }
        throw new Error(`Unexpected browser request: ${request.method} ${request.path}`);
      },
      launch: true,
      meetingSessionId: "session-1",
      meetingUrl: "https://meet.test/meeting",
      tab: { targetId: "target-1", openedByPlugin: true },
      timeoutMs: 1_000,
    });

    expect(buildLeaveScript).toHaveBeenCalledWith({
      meetingSessionId: "session-1",
      meetingUrl: "https://meet.test/meeting",
    });
    expect(deletedTabs).toEqual([]);
    expect(result).toEqual({
      left: true,
      note: "Test meeting tab belongs to another OpenClaw meeting session; left its current call untouched.",
    });
  });
});
