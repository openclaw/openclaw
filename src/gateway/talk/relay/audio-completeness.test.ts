import { describe, expect, it } from "vitest";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import { cancelTalkRealtimeRelayTurn, stopTalkRealtimeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";

const activeRelaySessions = new Map<string, string>();
usePersistentRelayTestState(activeRelaySessions);

describe("buffered relay audio completeness", () => {
  it.each([
    "normal",
    "drop-middle",
    "drop-last",
    "reorder",
    "empty",
    "cancelled",
    "failed",
    "incomplete",
    "clear",
    "cancel",
    "close",
  ] as const)("provides a loss-detectable buffered audio contract: %s", async (scenario) => {
    let request: RealtimeVoiceBridgeCreateRequest | undefined;
    const delivered: Array<Record<string, unknown>> = [];
    const deliveryOptions: Array<{ type: unknown; dropIfSlow?: boolean }> = [];
    let frame = 0;
    const session = createTalkRealtimeRelaySession({
      clientCapabilities: ["audio-completeness-v1"],
      connId: "conn-1",
      cfg: { agents: { entries: { main: {} } } },
      sessionTarget: prepareTalkSessionTarget(
        { agents: { entries: { main: {} } } },
        "agent:main:main",
      ),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      provider: createIdleRelayProvider((value) => {
        request = value;
        return makeRelayTransport();
      }),
      context: {
        chatAbortControllers: new Map(),
        broadcastToConnIds: (
          _name: string,
          payload: Record<string, unknown>,
          _ids: Set<string>,
          options: { dropIfSlow?: boolean },
        ) => {
          deliveryOptions.push({ type: payload.type, ...options });
          if (payload.type === "audio") {
            const ordinal = frame++;
            if (
              (scenario === "drop-middle" && ordinal === 1) ||
              (scenario === "drop-last" && ordinal === 2)
            ) {
              return;
            }
          }
          delivered.push(payload);
        },
      } as never,
    });
    activeRelaySessions.set(session.relaySessionId, "conn-1");
    expect(session.audioDelivery).toBe("audio-completeness-v1");
    request!.onEvent?.({ direction: "server", type: "response.created", responseId: "response-1" });
    if (scenario !== "empty") {
      request!.onAudio(Buffer.alloc(960 * 2 + 137));
    }
    if (scenario === "clear") {
      request!.onClearAudio("barge-in");
      request!.onAudio(Buffer.alloc(960));
    } else if (scenario === "cancel") {
      const cancelled = cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
      });
      request!.onResponseDone?.({ responseId: "response-1", status: "cancelled" });
      await cancelled;
    } else if (scenario === "close") {
      await stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
      });
    } else {
      request!.onResponseDone?.({
        responseId: "response-1",
        message: "synthetic terminal outcome",
        status:
          scenario === "cancelled" || scenario === "failed" || scenario === "incomplete"
            ? scenario
            : "completed",
      });
    }
    // A replayed completion must not revive cleared output or produce a second final.
    request!.onResponseDone?.({ responseId: "response-1", status: "completed" });
    const started = delivered.filter((event) => event.type === "audioStarted");
    const frames = delivered.filter((event) => event.type === "audio");
    if (scenario === "reorder") {
      [frames[0], frames[1]] = [frames[1]!, frames[0]!];
    }
    const finals = delivered.filter((event) => event.type === "audioDone" && event.output);
    expect(started).toEqual([
      { relaySessionId: session.relaySessionId, type: "audioStarted", outputId: 1 },
    ]);
    expect(finals).toHaveLength(1);
    const status =
      scenario === "clear" || scenario === "cancel"
        ? "cancelled"
        : scenario === "close"
          ? "incomplete"
          : scenario === "failed" || scenario === "incomplete" || scenario === "cancelled"
            ? scenario
            : "completed";
    expect(finals[0]).toMatchObject({
      status,
      output: { id: 1, frameCount: scenario === "empty" ? 0 : 3 },
    });
    const ordinals = frames.map(
      (event) => (event.output as { id: number; frameCount: number }).frameCount,
    );
    const expected = scenario === "empty" ? [] : [0, 1, 2];
    // A buffered receiver accepts only exactly 0..finalCount-1 in arrival order.
    expect(JSON.stringify(ordinals) === JSON.stringify(expected)).toBe(
      !["drop-middle", "drop-last", "reorder"].includes(scenario),
    );
    expect(
      deliveryOptions
        .filter((entry) => entry.type === "audioStarted" || entry.type === "audioDone")
        .every((entry) => entry.dropIfSlow === false),
    ).toBe(true);
    expect(
      deliveryOptions
        .filter((entry) => entry.type === "audio")
        .every((entry) => entry.dropIfSlow === false),
    ).toBe(true);
    expect(delivered.findIndex((event) => event.type === "audioStarted")).toBeLessThan(
      delivered.findIndex((event) => event.type === "audioDone"),
    );
  });
});
