import { describe, expect, it, vi } from "vitest";
import { leaveMeetingWithBrowser } from "./browser-session-control.js";

describe("meeting browser leave ownership", () => {
  async function leaveWithStep(step: {
    departed: boolean;
    sessionConflict?: boolean;
    sessionMatched?: boolean;
    urlMatched?: boolean;
  }) {
    const buildLeaveScript = vi.fn(() => "() => '{}'");
    const deletedTabs: string[] = [];
    const result = await leaveMeetingWithBrowser({
      adapter: {
        browserLabel: "Test meeting",
        browser: {
          buildLeaveScript,
          parseLeaveResult: () => step,
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
    return result;
  }

  it("does not close a tab whose page belongs to another session", async () => {
    const result = await leaveWithStep({
      departed: false,
      sessionConflict: true,
      sessionMatched: false,
      urlMatched: true,
    });

    expect(result).toEqual({
      left: true,
      note: "Test meeting tab belongs to another OpenClaw meeting session; left its current call untouched.",
    });
  });

  it("does not report success when page ownership is unverified", async () => {
    const result = await leaveWithStep({
      departed: false,
      sessionMatched: false,
      urlMatched: true,
    });

    expect(result).toEqual({
      left: false,
      note: "Browser control could not verify that the Test meeting tab still belongs to this OpenClaw meeting session.",
    });
  });
});
