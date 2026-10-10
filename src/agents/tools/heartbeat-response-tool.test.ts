// Heartbeat response tool tests cover the one-shot heartbeat contract and
// provider-portable schema shape.
import { describe, expect, it } from "vitest";
import { createHeartbeatResponseTool } from "./heartbeat-response-tool.js";

type HeartbeatResponseDetails = {
  status?: string;
  outcome?: string;
  notify?: boolean;
  summary?: string;
  notificationText?: string;
  priority?: string;
  nextCheck?: string;
  scratch?: string;
};

describe("createHeartbeatResponseTool", () => {
  it("rejects repeated heartbeat responses from the same tool instance", async () => {
    // A heartbeat turn has one final outcome; accepting multiple writes would
    // make notification delivery ambiguous.
    const tool = createHeartbeatResponseTool();

    await tool.execute("call-1", {
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    await expect(
      tool.execute("call-2", {
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      }),
    ).rejects.toThrow("heartbeat_respond already accepted");
  });

  it("captures scratch without echoing future prompt content to the model", async () => {
    const tool = createHeartbeatResponseTool();
    const scratch = "Private monitor context that must not enter tool output.";

    const result = await tool.execute("call-1", {
      outcome: "progress",
      notify: false,
      summary: "Updated monitor context.",
      scratch,
    });

    const details = result.details as HeartbeatResponseDetails;
    expect(details.scratch).toBe(scratch);
    expect(JSON.stringify(result.content)).not.toContain(scratch);
    expect(JSON.stringify(details)).not.toContain(scratch);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"scratchPending": true') }),
    ]);
  });

  it("rejects missing notify because quiet vs visible delivery must be explicit", async () => {
    const tool = createHeartbeatResponseTool();

    await expect(
      tool.execute("call-1", {
        outcome: "no_change",
        summary: "Nothing needs attention.",
      }),
    ).rejects.toThrow("notify required");
  });
});
