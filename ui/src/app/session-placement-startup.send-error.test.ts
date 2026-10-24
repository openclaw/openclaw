import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requestCloudWorkerStop } from "../components/cloud-worker-stop.runtime.ts";
import { writeSessionPlacementRecovery } from "../lib/sessions/session-placement-recovery.ts";
import {
  blockStorageWrites,
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
  readStartupRecovery,
  startupCalls,
  startupMethods,
  startupRequest,
} from "./session-placement-startup.test-support.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

describe("placement first-send diagnostic", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the first failure and latest check across reload, until an exact receipt arrives", async () => {
    let check = 0;
    const request = startupRequest({
      "sessions.dispatch": () =>
        Promise.resolve({ placement: createStartupPlacement("active", 1) }),
      "sessions.send": () => Promise.reject(new Error("socket interrupted during first send")),
      "chat.history": () => {
        check += 1;
        if (check === 1) {
          return Promise.resolve({ messages: [] });
        }
        if (check === 2) {
          return Promise.reject(new Error("history temporarily unavailable"));
        }
        return Promise.resolve({
          messages: [],
          inputReceipts: [{ runId: "message-stable", state: "pending" }],
        });
      },
    });
    const { startup, input, key, dependencies } = createPlacementStartupHarness(request);
    startup.start(input);
    await vi.waitFor(() =>
      expect(startup.get(key)?.error).toBe("socket interrupted during first send"),
    );
    startup.retry(key);
    await vi.waitFor(() => expect(startup.get(key)?.error).toContain("No matching user message"));
    expect(startup.get(key)?.error).toContain("socket interrupted during first send");
    startup.retry(key);
    const combined = "socket interrupted during first send\n\nhistory temporarily unavailable";
    await vi.waitFor(() => expect(startup.get(key)?.error).toBe(combined));
    expect(startup.get(key)?.initialTurn?.sendError).toBe(combined);
    expect(readStartupRecovery(input.recovery)).toMatchObject({
      messageId: "message-stable",
      message: "fix the cloud task",
      sendError: "socket interrupted during first send",
      error: "history temporarily unavailable",
      reason: "unconfirmed",
    });
    startup.dispose();
    const restored = createApplicationPlacementStartup(dependencies);
    try {
      restored.resumeRecovery();
      await vi.waitFor(() => expect(restored.get(key)?.error).toBe(combined));
      expect(check).toBe(2);
      restored.retry(key);
      await vi.waitFor(() => expect(restored.hasPendingTurn(key)).toBe(false));
      expect(readStartupRecovery(input.recovery)).toBeNull();
      expect(startupMethods(request)).toEqual([
        "sessions.dispatch",
        "sessions.send",
        "chat.history",
        "chat.history",
        "chat.history",
      ]);
    } finally {
      restored.dispose();
    }
  });

  it.each(["persistent", "memory", "failed-write"] as const)(
    "retains a late rejection without reopening the active Check delivery (%s)",
    async (storage) => {
      const send = createDeferred<unknown>();
      const history = createDeferred<{ messages: unknown[] }>();
      const request = startupRequest({
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 1) }),
        "sessions.send": () => send.promise,
        "sessions.reclaim": () => Promise.resolve({ ok: true }),
        "chat.history": () => history.promise,
      });
      const { startup, input, key, gateway } = createPlacementStartupHarness(request);
      input.persistRecovery = storage !== "memory";
      if (!input.persistRecovery) {
        sessionStorage.clear();
      }
      startup.start(input);
      await vi.waitFor(() => expect(startupCalls(request, "sessions.send")).toHaveLength(1));
      const client = gateway.snapshot.client;
      if (!client) {
        throw new Error("Expected the startup fixture client");
      }
      await requestCloudWorkerStop(client, { key }, startup);
      startup.retry(key);
      await vi.waitFor(() => expect(startupCalls(request, "chat.history")).toHaveLength(1));
      if (storage === "failed-write") {
        blockStorageWrites();
      }
      send.reject(new Error("late first-send failure"));
      try {
        await vi.waitFor(() =>
          expect(startup.get(key)?.error).toContain("late first-send failure"),
        );
        startup.retry(key);
        expect(startupCalls(request, "chat.history")).toHaveLength(1);
        if (storage === "failed-write") {
          expect(startup.get(key)?.error).toContain("Recovery could not be saved");
        }
        history.resolve({ messages: [] });
        await vi.waitFor(() =>
          expect(startup.get(key)?.error).toContain("No matching user message"),
        );
        expect(startup.get(key)?.error).toContain("late first-send failure");
        expect(startup.get(key)?.initialTurn?.sendError).toBe(startup.get(key)?.error);
        expect(startupCalls(request, "sessions.send")).toHaveLength(1);
        expect(startupCalls(request, "sessions.dispatch")).toHaveLength(1);
        expect(startupCalls(request, "sessions.reclaim")).toHaveLength(1);
        if (storage === "memory") {
          expect(sessionStorage.length).toBe(0);
        }
      } finally {
        history.resolve({ messages: [] });
      }
    },
  );

  it.each(["message", "credential"] as const)(
    "does not publish a late failure into a replacement %s owner",
    async (changed) => {
      const send = createDeferred<unknown>();
      const request = startupRequest({
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 1) }),
        "sessions.send": () => send.promise,
      });
      const { startup, input, key, client } = createPlacementStartupHarness(request);
      startup.start(input);
      await vi.waitFor(() => expect(startupCalls(request, "sessions.send")).toHaveLength(1));
      const retained = {
        ...input.recovery,
        phase: "sending" as const,
        ...(changed === "message"
          ? { messageId: "replacement-message", message: "new prompt" }
          : {}),
      };
      expect(writeSessionPlacementRecovery(retained)).toBe(true);
      if (changed === "credential") {
        client.recoveryScope = "principal-b";
      }
      send.reject(new Error("private original failure"));
      await flushStartupMicrotasks();
      expect(startup.get(key)).toBeNull();
      expect(readStartupRecovery(input.recovery)).toEqual(retained);
      expect(startupMethods(request)).toEqual(["sessions.dispatch", "sessions.send"]);
    },
  );

  it("bounds stored and displayed diagnostics without splitting surrogate pairs", async () => {
    const first = `first ${"a".repeat(2041)}🚀${"b".repeat(2100)}`;
    const latest = `last ${"c".repeat(2040)}🚀${"d".repeat(2200)}`;
    const request = startupRequest({
      "sessions.dispatch": () =>
        Promise.resolve({ placement: createStartupPlacement("active", 1) }),
      "sessions.send": () => Promise.reject(new Error(first)),
      "chat.history": () => Promise.reject(new Error(latest)),
    });
    const { startup, input, key } = createPlacementStartupHarness(request);
    startup.start(input);
    await vi.waitFor(() => expect(startup.get(key)?.phase).toBe("failed"));
    startup.retry(key);
    const combined = `first ${"a".repeat(2041)}\n\nlast ${"c".repeat(2040)}`;
    await vi.waitFor(() => expect(startup.get(key)?.error).toBe(combined));
    expect(startup.get(key)?.initialTurn?.sendError).toBe(combined);
    expect(readStartupRecovery(input.recovery)?.sendError).toHaveLength(4096);
    expect(startupCalls(request, "sessions.send")).toHaveLength(1);
  });
});
