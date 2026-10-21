// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  createTransport,
  startTransport,
  emitTalkEvent,
  requestCallsFor,
  listeners,
  processors,
  getUserMedia,
  installGatewayRelayTestFixture,
  talkEvent,
} from "./gateway-relay.test-support.ts";

describe("Gateway relay lifecycle callbacks", () => {
  installGatewayRelayTestFixture();

  it.each([
    ["ready", "session.ready"],
    ["close", "session.closed"],
  ] as const)("forwards only this relay's %s lifecycle signal", async (type, lifecycleType) => {
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ callbacks: { onTalkEvent } });

    await startTransport(transport);
    const event = {
      relaySessionId: "relay-other",
      type,
      talkEvent: talkEvent({
        id: "relay-other:1",
        type: lifecycleType,
        sessionId: "relay-other",
      }),
    };
    emitTalkEvent(event);

    expect(onTalkEvent).not.toHaveBeenCalled();
    emitTalkEvent({
      ...event,
      relaySessionId: "relay-1",
      talkEvent: { ...event.talkEvent, id: "relay-1:1", sessionId: "relay-1" },
    });
    expect(onTalkEvent).toHaveBeenCalledExactlyOnceWith({ type: lifecycleType });
    void transport.stop();
  });

  it.each(["talk event", "status"] as const)(
    "releases local resources when a close %s callback throws",
    async (callbackKind) => {
      const stopTrack = vi.fn();
      getUserMedia.mockResolvedValue({
        getTracks: () => [Object.assign(new EventTarget(), { stop: stopTrack })],
      } as unknown as MediaStream);
      const throwingCallback = vi.fn();
      const client = createClient();
      const transport = await createTransport({
        client,
        callbacks:
          callbackKind === "talk event"
            ? { onTalkEvent: throwingCallback }
            : { onStatus: throwingCallback },
      });

      await startTransport(transport);
      throwingCallback.mockImplementation(() => {
        throw new Error("consumer failed");
      });
      expect(() =>
        emitTalkEvent({
          relaySessionId: "relay-1",
          type: "close",
          reason: "error",
          talkEvent: callbackKind === "talk event" ? talkEvent({ final: true }) : undefined,
        }),
      ).toThrow("consumer failed");

      expect(stopTrack).toHaveBeenCalledOnce();
      expect(processors.at(-1)?.disconnect).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
      emitTalkEvent({ relaySessionId: "relay-1", type: "ready" });
      void transport.stop();
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
    },
  );
});
