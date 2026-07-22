import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestSessionObserverAnswer } from "./chat-observer.ts";

describe("chat observer ask rpc", () => {
  it("sends the observer ask RPC with the exact session payload", async () => {
    const request = vi.fn(async () => ({ answer: "It is rerunning a focused regression." }));

    await expect(
      requestSessionObserverAnswer(
        { request } as unknown as Pick<GatewayBrowserClient, "request">,
        "agent:main:current",
        "Why is it rerunning that test?",
      ),
    ).resolves.toEqual({ answer: "It is rerunning a focused regression." });
    expect(request).toHaveBeenCalledWith("sessions.observer.ask", {
      sessionKey: "agent:main:current",
      question: "Why is it rerunning that test?",
    });
  });
});
