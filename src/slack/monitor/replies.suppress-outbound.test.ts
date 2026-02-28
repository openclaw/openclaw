import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies } from "./replies.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

describe("deliverReplies suppressOutbound", () => {
  it("blocks delivery when suppressOutbound is true", async () => {
    await deliverReplies({
      replies: [{ text: "hello" }],
      target: "C123",
      token: "token",
      accountId: "default",
      runtime: {} as RuntimeEnv,
      textLimit: 4000,
      replyToMode: "off" as const,
      cfg: { channels: { slack: { suppressOutbound: true } } } as OpenClawConfig,
    });

    expect(sendMessageSlackMock).not.toHaveBeenCalled();
  });

  it("allows delivery when suppressOutbound is false", async () => {
    sendMessageSlackMock.mockResolvedValue(undefined);

    await deliverReplies({
      replies: [{ text: "hello" }],
      target: "C123",
      token: "token",
      accountId: "default",
      runtime: {} as RuntimeEnv,
      textLimit: 4000,
      replyToMode: "off" as const,
      cfg: { channels: { slack: {} } } as OpenClawConfig,
    });

    expect(sendMessageSlackMock).toHaveBeenCalled();
  });
});
