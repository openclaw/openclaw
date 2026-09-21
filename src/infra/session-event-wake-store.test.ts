import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";
import {
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  type SystemEvent,
} from "./system-events.js";

const target = { agentId: "main", sessionKey: "agent:main:parent" };
const wake = { ...target, source: "session-state" as const, intent: "immediate" as const };
let dispose: (() => void) | undefined;

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await drainGlobalSingletonLifecycleState();
  resetGatewayWorkAdmission();
  resetHeartbeatEventsForTest();
  vi.useRealTimers();
});

describe("session wake physical store ownership", () => {
  it("retains equivalent aliases without letting a retargeted alias rewrite queued ownership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const original = path.join(stateDir, "original");
      const replacement = path.join(stateDir, "replacement");
      const alias = path.join(stateDir, "selected");
      const equivalent = path.join(stateDir, "same-store");
      await fs.mkdir(original);
      await fs.mkdir(replacement);
      const originalPhysicalPath = path.join(await fs.realpath(original), "openclaw-agent.sqlite");
      await fs.symlink(original, alias, "junction");
      await fs.symlink(original, equivalent, "junction");
      vi.useFakeTimers();
      publishSystemEventStoreConfig({ session: { store: path.join(alias, "sessions.json") } });
      const handler = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
      dispose = setSessionEventWakeHandler(handler);
      enqueueSystemEvent("old child changed", { sessionKey: target.sessionKey });
      const pending = requestSessionEventWakeAndWait({ ...wake, coalesceMs: 20_000 });
      publishSystemEventStoreConfig({ session: { store: path.join(equivalent, "sessions.json") } });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(peekSystemEventEntries(target.sessionKey)).toHaveLength(1);
      expect(peekSystemEventEntries(target.sessionKey)[0]?.sessionStorePath).toBe(
        originalPhysicalPath,
      );
      await fs.unlink(alias);
      await fs.symlink(replacement, alias, "junction");
      publishSystemEventStoreConfig({ session: { store: path.join(alias, "sessions.json") } });
      await expect(pending).resolves.toEqual({ status: "skipped", reason: "store-replaced" });
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(target.sessionKey)).toEqual([]);
    });
  });

  it("retires queued work and its context at store publication, then admits new-store work", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      vi.useFakeTimers();
      const oldStore = path.join(env.OPENCLAW_STATE_DIR!, "old.sqlite");
      const newStore = path.join(env.OPENCLAW_STATE_DIR!, "new.sqlite");
      publishSystemEventStoreConfig({ session: { store: oldStore } });
      const handler = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
      dispose = setSessionEventWakeHandler(handler);
      enqueueSystemEvent("old child changed", { sessionKey: target.sessionKey });
      const pending = requestSessionEventWakeAndWait({ ...wake, coalesceMs: 20_000 });

      publishSystemEventStoreConfig({ session: { store: newStore } });
      await expect(pending).resolves.toEqual({ status: "skipped", reason: "store-replaced" });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "store-replaced",
      });
      expect(peekSystemEventEntries(target.sessionKey)).toEqual([]);
      requestSessionEventWake({ ...wake, sessionStorePath: oldStore, coalesceMs: 0 });
      requestSessionEventWake({ ...wake, sessionStorePath: null, coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(handler).not.toHaveBeenCalled();

      const current = requestSessionEventWakeAndWait({ ...wake, coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      await expect(current).resolves.toMatchObject({ status: "ran" });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionStorePath: newStore }),
        expect.any(AbortSignal),
      );
    });
  });

  it("never requeues a retired active wake even if the original store returns before settlement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      vi.useFakeTimers();
      const store = path.join(env.OPENCLAW_STATE_DIR!, "old.sqlite");
      const completion = createDeferred<{ status: "skipped"; reason: string }>();
      const handler = vi.fn(async () => completion.promise);
      publishSystemEventStoreConfig({ session: { store } });
      dispose = setSessionEventWakeHandler(handler);
      const pending = requestSessionEventWakeAndWait({ ...wake, coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledOnce();
      try {
        publishSystemEventStoreConfig({
          session: { store: path.join(env.OPENCLAW_STATE_DIR!, "new.sqlite") },
        });
        await expect(pending).resolves.toEqual({ status: "skipped", reason: "store-replaced" });
        publishSystemEventStoreConfig({ session: { store } });
      } finally {
        completion.resolve({ status: "skipped", reason: "active-run" });
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  it("hands queued notifications to a same-store runner after lifecycle cleanup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      vi.useFakeTimers();
      const store = path.join(env.OPENCLAW_STATE_DIR!, "same.sqlite");
      const retired = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
      const delivered = new Map<string, SystemEvent[]>();
      const replacement = vi.fn(async (request: HeartbeatWakeRequest) => {
        const sessionKey = expectDefined(request.sessionKey, "notification session key");
        delivered.set(sessionKey, drainSystemEventEntries(sessionKey));
        return { status: "ran" as const, durationMs: 1 };
      });
      publishSystemEventStoreConfig({ session: { store } });
      dispose = setSessionEventWakeHandler(retired);
      const queuedPayload = expectDefined(
        enqueueSystemEventEntry("Child finished before restart", {
          sessionKey: target.sessionKey,
          contextKey: "child:finished",
          deliveryContext: { channel: "telegram", to: "123", threadId: "456" },
        }),
        "queued notification payload",
      );
      requestSessionEventWake({ ...wake, coalesceMs: 20_000 });
      dispose();
      await drainGlobalSingletonLifecycleState("restart");
      const handoff = { ...wake, sessionKey: "agent:main:restart-handoff" };
      const handoffPayload = expectDefined(
        enqueueSystemEventEntry("Child finished during restart", {
          sessionKey: handoff.sessionKey,
          sessionStorePath: store,
          contextKey: "child:handoff",
          deliveryContext: { channel: "discord", to: "channel:789" },
        }),
        "handoff notification payload",
      );
      requestSessionEventWake({ ...handoff, sessionStorePath: store, coalesceMs: 20_000 });
      // The CLI drains again before boot, after the retiring server's own restart drain.
      await drainGlobalSingletonLifecycleState("restart");
      publishSystemEventStoreConfig({ session: { store } });
      dispose = setSessionEventWakeHandler(replacement);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(retired).not.toHaveBeenCalled();
      expect(replacement).toHaveBeenCalledTimes(2);
      expect(replacement).toHaveBeenCalledWith(
        expect.objectContaining({ ...wake, sessionStorePath: store }),
        expect.any(AbortSignal),
      );
      expect(replacement).toHaveBeenCalledWith(
        expect.objectContaining({ ...handoff, sessionStorePath: store }),
        expect.any(AbortSignal),
      );
      expect(delivered).toEqual(
        new Map([
          [target.sessionKey, [queuedPayload]],
          [handoff.sessionKey, [handoffPayload]],
        ]),
      );
      expect(peekSystemEventEntries(target.sessionKey)).toEqual([]);
      expect(peekSystemEventEntries(handoff.sessionKey)).toEqual([]);
    });
  });
});
