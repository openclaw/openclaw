import { describe, expect, it, vi } from "vitest";

const sendMessageSlack = vi.fn(async (..._args: unknown[]) => ({
  messageId: "m1",
  channelId: "C1",
}));

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: Parameters<typeof sendMessageSlack>) => sendMessageSlack(...args),
}));

const { sendSlackMessage } = await import("./actions.js");

describe("sendSlackMessage", () => {
  it("passes mediaLocalRoots through to sendMessageSlack", async () => {
    const mediaLocalRoots = ["/tmp/workspace-agent"] as const;

    await sendSlackMessage("channel:C1", "report", {
      mediaUrl: "/tmp/workspace-agent/report.pdf",
      mediaLocalRoots,
      token: "xoxb-test",
    });

    expect(sendMessageSlack).toHaveBeenCalledWith("channel:C1", "report", {
      accountId: undefined,
      token: "xoxb-test",
      mediaUrl: "/tmp/workspace-agent/report.pdf",
      mediaLocalRoots,
      client: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });
});
