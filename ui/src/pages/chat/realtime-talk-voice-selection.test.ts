import type { TalkVoiceChangeEvent, TalkVoiceSelection } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import {
  RealtimeTalkVoiceSelection,
  type RealtimeVoiceCall,
  type RealtimeVoiceSelectionState,
} from "./realtime-talk-voice-selection.ts";

const change: TalkVoiceChangeEvent = {
  changeId: "change-1",
  sessionKey: "agent:main:voice",
  voiceSessionId: "old-call",
  voice: "spruce",
  phase: "requested",
};
const selection: TalkVoiceSelection = {
  voiceSessionId: "old-call",
  sessionKey: change.sessionKey,
  provider: "openai",
  model: "gpt-live-1-codex",
  voice: "cove",
  voices: ["cove", "spruce"],
  canChange: true,
};

function fixture() {
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const previous: RealtimeVoiceCall = { getVoiceSessionId: () => "old-call" };
  const candidate: RealtimeVoiceCall = { getVoiceSessionId: () => "new-call" };
  let current: RealtimeVoiceCall | null = previous;
  let currentOwner = true;
  const started = createDeferred<RealtimeVoiceCall | undefined>();
  const request = vi.fn(
    async (method: string, _params?: unknown, _options?: unknown): Promise<unknown> =>
      method === "talk.voice.get"
        ? { ...selection, voiceSessionId: current?.getVoiceSessionId() }
        : { ok: true },
  );
  const updates: RealtimeVoiceSelectionState[] = [];
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
    update: (state) => updates.push(state),
  });
  return {
    controller,
    candidate,
    previous,
    started,
    request,
    updates,
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
  it.each(["ready-first", "start-first"])(
    "acknowledges a fresh call only after readiness and startup: %s",
    async (order) => {
      const f = fixture();
      try {
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
      } finally {
        f.controller.dispose();
      }
    },
  );

  it.each([
    { ...change, sessionKey: "agent:other:voice" },
    { ...change, voiceSessionId: "another-call" },
    { ...change, phase: "unexpected" },
  ])(
    "ignores an event outside its exact call contract: $sessionKey/$voiceSessionId/$phase",
    (payload) => {
      const f = fixture();
      try {
        f.emit(payload);
        expect(f.restart).not.toHaveBeenCalled();
      } finally {
        f.controller.dispose();
      }
    },
  );

  it("ignores matching IDs after the owning client or chat has changed", () => {
    const f = fixture();
    f.loseOwner();
    f.emit(change);
    expect(f.restart).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it("cancels only its matching operation and rejects late startup/readiness", async () => {
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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

  it("uses the Gateway selection without inventing a default and gives set the full operation budget", async () => {
    const f = fixture();
    try {
      f.request.mockResolvedValueOnce({ ...selection, voice: undefined });
      await f.controller.refresh();
      expect(f.updates.at(-1)?.selection?.voice).toBeUndefined();
      await f.controller.set("unsupported");
      expect(f.request.mock.calls.some(([method]) => method === "talk.voice.set")).toBe(false);
      f.request.mockResolvedValueOnce({ ...selection, voice: "spruce", status: "applied" });
      await f.controller.set("spruce");
      expect(f.request).toHaveBeenLastCalledWith(
        "talk.voice.set",
        {
          sessionKey: change.sessionKey,
          voiceSessionId: "old-call",
          voice: "spruce",
        },
        { timeoutMs: 70_000 },
      );
      expect(f.updates.at(-1)?.selection?.voice).toBe("spruce");
    } finally {
      f.controller.dispose();
    }
  });

  it("drops a catalog result after losing its owning client", async () => {
    const f = fixture();
    const result = createDeferred<TalkVoiceSelection>();
    f.request.mockReturnValueOnce(result.promise);
    const loading = f.controller.refresh();
    f.loseOwner();
    result.resolve(selection);
    await loading;
    expect(f.updates).toEqual([]);
    f.controller.dispose();
  });
});
