import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies, deliverSlackSlashReplies } from "./replies.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

vi.mock("../format.js", () => ({
  markdownToSlackMrkdwnChunks: (text: string) => [text],
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

describe("deliverSlackSlashReplies suppressOutbound", () => {
  it("blocks slash reply when suppressOutbound is true", async () => {
    const respond = vi.fn();
    await deliverSlackSlashReplies({
      replies: [{ text: "hello" }],
      respond,
      ephemeral: true,
      textLimit: 4000,
      cfg: { channels: { slack: { suppressOutbound: true } } } as OpenClawConfig,
      accountId: "default",
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("allows slash reply when not suppressed", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    await deliverSlackSlashReplies({
      replies: [{ text: "hello" }],
      respond,
      ephemeral: true,
      textLimit: 4000,
      cfg: { channels: { slack: {} } } as OpenClawConfig,
      accountId: "default",
    });
    expect(respond).toHaveBeenCalled();
  });
});
