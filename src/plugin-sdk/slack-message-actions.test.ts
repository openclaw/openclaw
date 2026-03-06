import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./slack-message-actions.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({
    ok: true,
    content: action,
  }));
}

describe("handleSlackMessageAction", () => {
  it("forwards trusted mediaLocalRoots for send actions", async () => {
    const invoke = createInvokeSpy();
    const mediaLocalRoots = ["/tmp/workspace-agent"] as const;

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        mediaLocalRoots,
        params: {
          to: "channel:C1",
          media: "/tmp/workspace-agent/report.pdf",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:C1",
        mediaUrl: "/tmp/workspace-agent/report.pdf",
      }),
      {},
      undefined,
      { mediaLocalRoots },
    );
  });
});
