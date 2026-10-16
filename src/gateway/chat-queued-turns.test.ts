import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import {
  abortQueuedChatTurnById,
  abortQueuedChatTurns,
  completeQueuedChatTurn,
  listQueuedChatTurnsForSession,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnMap,
} from "./chat-queued-turns.js";

function emptyMap(): QueuedChatTurnMap {
  return new Map();
}

function registerTurn(
  map: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
  sessionId = runId,
  options: Partial<Parameters<typeof registerQueuedChatTurn>[0]> = {},
): boolean {
  return registerQueuedChatTurn({
    chatQueuedTurns: map,
    runId,
    controller,
    sessionId,
    sessionKey: "main",
    ...options,
  });
}

describe("chat-queued-turns", () => {
  it("records cancellation while the exact queued owner still exists, then removes it", () => {
    const map = emptyMap();
    const controller = new AbortController();
    let observedController: AbortController | undefined;
    expect(
      registerTurn(map, "run-abort", controller, "sess-abort", {
        onAborted: () => {
          observedController = map.get("run-abort")?.controller;
        },
      }),
    ).toBe(true);
    controller.abort();
    expect(observedController).toBe(controller);
    expect(map.get("run-abort")).toBeUndefined();
  });

  it("does not publish cancellation from a replaced owner", () => {
    const map = emptyMap();
    const first = new AbortController();
    const second = new AbortController();
    let cancelled = false;
    expect(
      registerTurn(map, "reused", first, "old", {
        onAborted: () => {
          cancelled = true;
        },
      }),
    ).toBe(true);
    map.set("reused", { controller: second, sessionId: "new", sessionKey: "main" });
    first.abort();
    expect(cancelled).toBe(false);
    expect(map.get("reused")?.controller).toBe(second);
  });

  it("does not let a stale abort listener remove a reused run id", () => {
    const map = emptyMap();
    const first = new AbortController();
    const second = new AbortController();
    expect(registerTurn(map, "run-reused", first, "sess-a")).toBe(true);
    expect(completeQueuedChatTurn(map, "run-reused", first)).toBe(true);
    expect(registerTurn(map, "run-reused", second, "sess-b")).toBe(true);

    first.abort();

    expect(map.get("run-reused")?.controller).toBe(second);
    second.abort();
    expect(map.get("run-reused")).toBeUndefined();
  });

  it("does not let stale lifecycle callbacks mutate a reused run id", () => {
    const map = emptyMap();
    const first = new AbortController();
    const second = new AbortController();
    expect(registerTurn(map, "run-reused", first, "sess-a")).toBe(true);

    first.abort();
    expect(registerTurn(map, "run-reused", second, "sess-b")).toBe(true);

    expect(retireQueuedChatTurnCancellation(map, "run-reused", first)).toBe(false);
    expect(completeQueuedChatTurn(map, "run-reused", first)).toBe(false);
    const current = map.get("run-reused");
    expect(current?.controller).toBe(second);
    expect(current?.abortable).toBeUndefined();
  });

  it.each(["single", "bulk"] as const)(
    "preserves a synchronous replacement during %s abort cleanup",
    (mode) => {
      const map = emptyMap();
      const first = new AbortController();
      const second = new AbortController();
      expect(registerTurn(map, "run-replaced", first, "sess-a")).toBe(true);
      const firstEntry = map.get("run-replaced");
      expect(firstEntry).toBeDefined();
      first.signal.addEventListener(
        "abort",
        () => {
          expect(registerTurn(map, "run-replaced", second, "sess-b")).toBe(true);
        },
        { once: true },
      );

      const aborted =
        mode === "single"
          ? abortQueuedChatTurnById(map, {
              runId: "run-replaced",
              sessionKey: "main",
            }).aborted
          : abortQueuedChatTurns(map, [{ runId: "run-replaced", entry: firstEntry! }]).includes(
              "run-replaced",
            );

      expect(aborted).toBe(true);
      expect(map.get("run-replaced")?.controller).toBe(second);
    },
  );

  it("rejects re-register with a different controller", () => {
    const map = emptyMap();
    const first = new AbortController();
    registerTurn(map, "run-a", first, "sess-a");
    expect(registerTurn(map, "run-a", new AbortController(), "sess-a")).toBe(false);
  });

  it("preserves whitespace-distinct protocol run IDs", () => {
    const map = emptyMap();
    const spaced = new AbortController();
    const plain = new AbortController();
    expect(registerTurn(map, " run-a ", spaced, "sess-a")).toBe(true);
    expect(registerTurn(map, "run-a", plain, "sess-a")).toBe(true);

    expect(map.get(" run-a ")?.controller).toBe(spaced);
    expect(abortQueuedChatTurnById(map, { runId: " run-a ", sessionKey: "main" }).aborted).toBe(
      true,
    );
    expect(map.has("run-a")).toBe(true);
    expect(plain.signal.aborted).toBe(false);
  });

  it.each(["rpc", "restart"])("aborts by runId and preserves %s disposition", (stopReason) => {
    const map = emptyMap();
    const controller = new AbortController();
    const onAborted = vi.fn();
    registerTurn(map, "run-b", controller, "sess-b", { onAborted });
    const res = abortQueuedChatTurnById(map, {
      runId: "run-b",
      sessionKey: "main",
      stopReason,
    });
    expect(res.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(isAgentRunRestartAbortReason(controller.signal.reason)).toBe(stopReason === "restart");
    expect(map.has("run-b")).toBe(false);
    expect(onAborted).toHaveBeenCalledExactlyOnceWith(stopReason);
  });

  it("retains a retired collect source identity until aggregate completion", () => {
    const map = emptyMap();
    const controller = new AbortController();
    registerTurn(map, "run-collected", controller, "sess-collected");

    expect(retireQueuedChatTurnCancellation(map, "run-collected", controller)).toBe(true);
    expect(
      abortQueuedChatTurnById(map, { runId: "run-collected", sessionKey: "main" }).aborted,
    ).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(map.has("run-collected")).toBe(true);
    expect(listQueuedChatTurnsForSession({ chatQueuedTurns: map, sessionKeys: ["main"] })).toEqual(
      [],
    );
    controller.abort();
    expect(map.get("run-collected")?.abortable).toBe(false);
    expect(completeQueuedChatTurn(map, "run-collected", controller)).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("refuses abort when sessionKey mismatches unless allowed", () => {
    const map = emptyMap();
    const controller = new AbortController();
    registerTurn(map, "run-c", controller, "sess-c");
    expect(abortQueuedChatTurnById(map, { runId: "run-c", sessionKey: "other" }).aborted).toBe(
      false,
    );
    expect(controller.signal.aborted).toBe(false);
    expect(
      abortQueuedChatTurnById(map, {
        runId: "run-c",
        sessionKey: "other",
        allowSessionMismatch: true,
      }).aborted,
    ).toBe(true);
  });

  it("lists session matches and supports global agent scoping", () => {
    const map = emptyMap();
    registerTurn(map, "g-main", new AbortController(), "s1", {
      sessionKey: "global",
      agentId: "main",
    });
    registerTurn(map, "g-other", new AbortController(), "s2", {
      sessionKey: "global",
      agentId: "other",
    });
    registerTurn(map, "local", new AbortController(), "s3", { sessionKey: "agent:main:main" });
    const globalMain = listQueuedChatTurnsForSession({
      chatQueuedTurns: map,
      sessionKeys: ["global"],
      agentId: "main",
      defaultAgentId: "main",
    });
    expect(globalMain.map((m) => m.runId).toSorted()).toEqual(["g-main"]);
    const local = listQueuedChatTurnsForSession({
      chatQueuedTurns: map,
      sessionKeys: ["agent:main:main"],
    });
    expect(local.map((m) => m.runId)).toEqual(["local"]);
  });

  it.each(["rpc"])("aborts authorized matches with %s before returning runIds", (stopReason) => {
    const map = emptyMap();
    const a = new AbortController();
    const b = new AbortController();
    registerTurn(map, "qa", a, "s");
    registerTurn(map, "qb", b, "s");
    const matches = listQueuedChatTurnsForSession({
      chatQueuedTurns: map,
      sessionKeys: ["main"],
    });
    const runIds = abortQueuedChatTurns(map, matches, stopReason);
    expect(runIds.toSorted()).toEqual(["qa", "qb"]);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(isAgentRunRestartAbortReason(a.signal.reason)).toBe(stopReason === "restart");
    expect(isAgentRunRestartAbortReason(b.signal.reason)).toBe(stopReason === "restart");
    expect(map.size).toBe(0);
  });
});
