import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as confirmedVisibleMessage from "../../sessions/confirmed-visible-message.js";
import { recordDirectGatewayMessageActionSend } from "./message-action-gateway-transcript.js";

describe("recordDirectGatewayMessageActionSend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cfg = {} as OpenClawConfig;

  it("commits confirmed destination history for settled direct plugin sends", async () => {
    const commitSpy = vi
      .spyOn(confirmedVisibleMessage, "commitConfirmedVisibleMessage")
      .mockResolvedValueOnce({ ok: true });

    await recordDirectGatewayMessageActionSend(
      {
        cfg,
        channel: "telegram",
        params: { target: "chat-123", message: "hello from cli", threadId: "42" },
        accountId: "default",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
      { ok: true, messageId: "tg-direct-1" },
      "idem-direct-1",
    );

    expect(commitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "chat-123",
        accountId: "default",
        threadId: "42",
        deliveryId: "idem-direct-1",
        payload: { text: "hello from cli" },
      }),
    );
  });

  it("skips destination history on partial delivery", async () => {
    const commitSpy = vi
      .spyOn(confirmedVisibleMessage, "commitConfirmedVisibleMessage")
      .mockResolvedValueOnce({ ok: true });

    await recordDirectGatewayMessageActionSend(
      {
        cfg,
        channel: "telegram",
        params: { target: "chat-123", message: "partial" },
      },
      { ok: true, status: "partial_failed" },
      "idem-partial-1",
    );

    expect(commitSpy).not.toHaveBeenCalled();
  });
});
