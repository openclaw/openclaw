import { describe, expect, it } from "vitest";
import { collectBlueBubblesStatusIssues } from "./bluebubbles.js";

describe("collectBlueBubblesStatusIssues", () => {
  it("reports helper disconnected even when ping still works", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        probe: { ok: true, status: 200 },
        helperConnected: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "bluebubbles",
        accountId: "default",
        message: expect.stringContaining("helper disconnected"),
      }),
    ]);
  });

  it("reports private api disabled even when the server is reachable", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        probe: { ok: true, status: 200 },
        privateApi: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "bluebubbles",
        accountId: "default",
        message: expect.stringContaining("Private API disabled"),
      }),
    ]);
  });

  it("reports a missing live webhook route when ping still works", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        webhookPath: "/bluebubbles-webhook",
        webhookRouteRegistered: false,
        probe: { ok: true, status: 200 },
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "bluebubbles",
        accountId: "default",
        message: expect.stringContaining("webhook route missing"),
      }),
    ]);
  });
});
