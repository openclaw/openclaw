import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies } from "./replies.js";

vi.mock("../send.js", () => ({
  sendMessageSlack: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { sendMessageSlack } = await import("../send.js");
const sendMock = vi.mocked(sendMessageSlack);

function makeRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
}

describe("slack deliverReplies reasoning-only filtering", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("skips replies that are reasoning-only (Reasoning: prefix)", async () => {
    const replies: ReplyPayload[] = [
      { text: "Reasoning:\nThe user asked about X so I need to consider Y" },
    ];
    await deliverReplies({
      replies,
      target: "C123",
      token: "xoxb-test",
      runtime: makeRuntime(),
      textLimit: 4000,
      replyToMode: "off",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips replies that are reasoning-only (thinking tags)", async () => {
    const replies: ReplyPayload[] = [
      { text: "<thinking>Let me consider this carefully</thinking>" },
    ];
    await deliverReplies({
      replies,
      target: "C123",
      token: "xoxb-test",
      runtime: makeRuntime(),
      textLimit: 4000,
      replyToMode: "off",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("delivers normal text replies", async () => {
    const replies: ReplyPayload[] = [{ text: "The answer is 42" }];
    await deliverReplies({
      replies,
      target: "C123",
      token: "xoxb-test",
      runtime: makeRuntime(),
      textLimit: 4000,
      replyToMode: "off",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("delivers replies that contain reasoning tags mixed with answer text", async () => {
    const replies: ReplyPayload[] = [{ text: "Here is the answer based on my analysis." }];
    await deliverReplies({
      replies,
      target: "C123",
      token: "xoxb-test",
      runtime: makeRuntime(),
      textLimit: 4000,
      replyToMode: "off",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
