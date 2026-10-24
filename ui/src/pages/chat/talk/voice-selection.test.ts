import type { TalkVoiceChangeEvent } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../../api/gateway.ts";
import { RealtimeTalkVoiceSelection, type RealtimeVoiceCall } from "./voice-selection.ts";

const change: TalkVoiceChangeEvent = {
  changeId: "change-1",
  sessionKey: "agent:main:voice",
  voiceSessionId: "old-call",
  voice: "spruce",
  phase: "requested",
};

function fixture() {
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const previous: RealtimeVoiceCall = { getVoiceSessionId: () => "old-call" };
  const candidate: RealtimeVoiceCall = { getVoiceSessionId: () => "new-call" };
  let current: RealtimeVoiceCall | null = previous;
  let currentOwner = true;
  const started = createDeferred<RealtimeVoiceCall | undefined>();
  const request = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => ({
    ok: true,
  }));
  const cancel = vi.fn(() => {
    current = null;
    controller.dispose();
  });
  const restart = vi.fn(() => {
    current = candidate;
    return started.promise;
  });
  const client = {
    request,
    addEventListener: (listener: (event: GatewayEventFrame) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as GatewayBrowserClient;
  const controller = new RealtimeTalkVoiceSelection({
    client,
    sessionKey: change.sessionKey,
    currentCall: () => current,
    isCurrent: () => currentOwner,
    restart,
    cancel,
  });
  return {
    controller,
    candidate,
    previous,
    started,
    request,
    restart,
    cancel,
    listeners,
    loseOwner: () => {
      currentOwner = false;
    },
    emit: (payload: unknown) => {
      for (const listener of listeners) {
        listener({ type: "event", event: "talk.voice.change", payload });
      }
    },
    completions: () => request.mock.calls.filter(([method]) => method === "talk.voice.complete"),
  };
}

describe("active Talk voice selection", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => f.controller.dispose());
  it.each(["ready-first", "start-first"])(
    "acknowledges a fresh call only after readiness and startup: %s",
    async (order) => {
      f.emit(change);
      f.controller.ready(f.previous);
      if (order === "ready-first") {
        f.controller.ready(f.candidate);
      } else {
        f.started.resolve(f.candidate);
      }
      await Promise.resolve();
      expect(f.completions()).toEqual([]);
      if (order === "ready-first") {
        f.started.resolve(f.candidate);
      } else {
        f.controller.ready(f.candidate);
      }
      await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
      expect(f.completions()[0]).toEqual([
        "talk.voice.complete",
        { changeId: change.changeId, voiceSessionId: "new-call", outcome: "ready" },
        { timeoutMs: 70_000 },
      ]);
      f.controller.ready(f.candidate);
      await Promise.resolve();
      expect(f.completions()).toHaveLength(1);
    },
  );

  it.each([
    { ...change, sessionKey: "agent:other:voice" },
    { ...change, voiceSessionId: "another-call" },
    { ...change, phase: "unexpected" },
  ])(
    "ignores an event outside its exact call contract: $sessionKey/$voiceSessionId/$phase",
    (payload) => {
      f.emit(payload);
      expect(f.restart).not.toHaveBeenCalled();
    },
  );

  it("ignores matching IDs after the owning client or chat has changed", () => {
    f.loseOwner();
    f.emit(change);
    expect(f.restart).not.toHaveBeenCalled();
  });

  it("cancels only its matching operation and rejects late startup/readiness", async () => {
    f.emit(change);
    f.emit({ ...change, phase: "cancelled", changeId: "other-change" });
    expect(f.cancel).not.toHaveBeenCalled();
    f.emit({ ...change, phase: "cancelled" });
    expect(f.cancel).toHaveBeenCalledOnce();
    f.started.resolve(f.candidate);
    f.controller.ready(f.candidate);
    await Promise.resolve();
    expect(f.completions()).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });

  it("reports failure on Stop without accepting a late ready event", async () => {
    f.emit(change);
    f.controller.dispose();
    f.started.resolve(f.candidate);
    f.controller.ready(f.candidate);
    await Promise.resolve();
    expect(f.completions()).toHaveLength(1);
    expect(f.completions()[0]?.[1]).toMatchObject({ changeId: change.changeId, outcome: "failed" });
    expect(f.listeners.size).toBe(0);
  });

  it("propagates replacement audio failure before readiness", async () => {
    f.emit(change);
    f.controller.failed(f.candidate);
    f.started.resolve(f.candidate);
    f.controller.ready(f.candidate);
    await Promise.resolve();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.completions()).toHaveLength(1);
    expect(f.completions()[0]?.[1]).toMatchObject({
      outcome: "failed",
      voiceSessionId: "new-call",
    });
  });
});
