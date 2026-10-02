import { describe, expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";

describe("sessions tool sidebar settings", () => {
  it("patches and clears title, icon, group, status, attention, and archive state", async () => {
    const automationPause = { status: "partial", pausedCount: 1, failedCount: 2 } as const;
    const callGateway = vi.fn(async () => ({ ok: true, automationPause }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "session-main",
      config: {},
      callGateway: callGateway as never,
    });

    const archived = await tool.execute("declare", {
      action: "patch",
      label: "Waiting on staging",
      icon: "🦞",
      group: "P1 issues from beta feedback",
      statusNote: "Blocked: need the staging password",
      attention: "key",
      ttlMinutes: 45,
      archived: true,
    });
    expect(archived.details).toMatchObject({ status: "updated", automationPause });
    await tool.execute("clear", {
      action: "patch",
      label: "",
      icon: "",
      group: "",
      attention: "clear",
    });
    await tool.execute("clear-null", { action: "patch", group: null });

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: "Waiting on staging",
            icon: "🦞",
            category: "P1 issues from beta feedback",
            statusNote: "Blocked: need the staging password",
            attention: "key",
            ttlMinutes: 45,
            archived: true,
            expectedSessionId: "session-main",
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: null,
            icon: null,
            category: null,
            attention: null,
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            category: null,
          },
        },
      ],
    ]);
  });
});
