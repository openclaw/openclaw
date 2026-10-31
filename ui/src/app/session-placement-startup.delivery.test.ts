import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import { chatStartupStatusLabel } from "../pages/chat/chat-run-startup.ts";
import { restoreMocksAndGlobals } from "../test-helpers/mock-cleanup.ts";
import type { ApplicationGateway } from "./gateway.ts";
import createRuntime from "./session-placement-startup.runtime.ts";
import {
  blockStorageWrites,
  createPlacementStartupHarness,
  readStartupRecovery,
  startupCalls,
  startupRequest,
  startupMethods,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";

describe("application placement delivery recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    [true, "retryable", 1250],
    [false, "timeout", 500],
  ] as const)(
    "retries first input on a healthy connection (persistent=%s, %s)",
    async (persistRecovery, failure, delayMs) => {
      vi.useFakeTimers();
      let attempts = 0;
      const request = startupRequest({
        "sessions.dispatch": () => ({ placement: createStartupPlacement("active", 1) }),
        "chat.send": (payload) => {
          if (++attempts === 1) {
            throw failure === "timeout"
              ? new GatewayProtocolRequestTimeoutError({
                  method: "chat.send",
                  timeoutMs: 300000,
                  requestSent: true,
                })
              : new GatewayRequestError({
                  code: "UNAVAILABLE",
                  message: "Busy",
                  retryable: true,
                  retryAfterMs: delayMs,
                });
          }
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      });
      const { key, startup, input, client, chatSubmissions } =
        createPlacementStartupHarness(request);
      if (!persistRecovery) {
        sessionStorage.clear();
      }
      startup.start({ ...input, persistRecovery });
      await vi.advanceTimersByTimeAsync(0);
      expect(startup.get(key)?.initialTurn?.sendState).toBe("waiting-reconnect");
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(startupCalls(request, "chat.send")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const sends = startupCalls(request, "chat.send");
      expect(sends).toHaveLength(2);
      expect(sends[1]?.[1]).toEqual(sends[0]?.[1]);
      expect(startupCalls(request, "sessions.dispatch")).toHaveLength(1);
      expect(startup.get(key)).toBeNull();
      expect(chatSubmissions.readInitial(key, client)?.pendingRunId).toBe(input.recovery.messageId);
    },
  );

  it.each(["discard", "pause", "dispose", "credential"] as const)(
    "cancels the first-input retry after %s",
    async (change) => {
      vi.useFakeTimers();
      const request = startupRequest({
        "chat.send": () =>
          Promise.reject(
            new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "Busy",
              retryable: true,
              retryAfterMs: 1250,
            }),
          ),
      });
      const { key, startup, input, client } = createPlacementStartupHarness(request);
      startup.start({ ...input, recovery: { ...input.recovery, phase: "sending" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(startup.get(key)?.initialTurn?.sendState).toBe("waiting-reconnect");
      if (change === "credential") {
        client.recoveryScope = "principal-b";
      } else if (change === "pause") {
        startup.pause(key, "Stopped", {
          readSessionPlacementRecovery,
          pauseSessionPlacementRecovery,
        });
      } else if (change === "discard") {
        startup.discard(key);
      } else {
        startup.dispose();
      }
      await vi.advanceTimersByTimeAsync(1250);
      expect(startupCalls(request, "chat.send")).toHaveLength(1);
    },
  );

  it.each(["sending", "paused"] as const)(
    "retains persisted %s input without a physical binding until explicit Retry",
    async (phase) => {
      const request = startupRequest({
        "sessions.describe": () =>
          Promise.resolve({
            session: {
              sessionId: "resolved-session",
              placement: createStartupPlacement("active", 1),
            },
          }),
        "chat.send": (payload) => Promise.resolve({ runId: payload.idempotencyKey, status: "ok" }),
      });
      const { key, startup, input, client, chatSubmissions } =
        createPlacementStartupHarness(request);
      const recovery = {
        ...input.recovery,
        sessionId: undefined,
        attachments: [{ type: "file", mimeType: "text/plain", content: "SGk=" }],
        phase,
        ...(phase === "paused"
          ? { reason: "unconfirmed", error: "A saved delivery diagnostic" }
          : {}),
      };
      sessionStorage.setItem(
        sessionPlacementRecoveryExactStorageKey(recovery.gatewayUrl, recovery.recoveryScope, key),
        JSON.stringify(recovery),
      );

      startup.resumeRecovery();

      await vi.waitFor(() => expect(startup.get(key)?.phase).toBe("failed"));
      expect(startup.get(key)?.initialTurn).toMatchObject({
        text: recovery.message,
        sendRunId: recovery.messageId,
      });
      expect(readStartupRecovery(input.recovery)).toMatchObject({
        phase: "paused",
        reason: "not-sent",
        message: recovery.message,
        messageId: recovery.messageId,
        attachments: recovery.attachments,
      });
      expect(request).not.toHaveBeenCalled();

      startup.retry(key);

      await vi.waitFor(() => expect(startup.get(key)).toBeNull());
      expect(startupCalls(request, "chat.send")).toHaveLength(1);
      expect(startupCalls(request, "chat.send")[0]?.[1]).toMatchObject({
        sessionKey: key,
        sessionId: "resolved-session",
        idempotencyKey: recovery.messageId,
        attachments: recovery.attachments,
      });
      expect(chatSubmissions.readInitial(key, client)?.pendingRunId).toBe(recovery.messageId);
    },
  );

  it("binds a first-message retry to its original physical session after replacement", async () => {
    let physicalSessionId = "original-session";
    let turns = 0;
    const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({
          sessionId: physicalSessionId,
          placement: createStartupPlacement("active", 1),
        });
      }
      if (method === "sessions.describe") {
        return Promise.resolve({
          session: {
            sessionId: physicalSessionId,
            placement: createStartupPlacement("active", 1),
          },
        });
      }
      if (method === "chat.send") {
        if (payload?.sessionId && payload.sessionId !== physicalSessionId) {
          return Promise.reject(
            new GatewayRequestError({ code: "INVALID_REQUEST", message: "session changed" }),
          );
        }
        turns += 1;
        return turns === 1
          ? Promise.reject(new Error("socket closed after send"))
          : Promise.resolve({ runId: payload?.idempotencyKey, status: "started" });
      }
      if (method === "sessions.reclaim") {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`Unexpected ${method}`);
    });
    const { key, startup, input, client, gateway } = createPlacementStartupHarness(request);
    input.recovery = { ...input.recovery, sessionId: undefined };
    writeSessionPlacementRecovery(input.recovery);
    startup.start(input);
    await vi.waitFor(() =>
      expect(startup.get(key)?.initialTurn?.sendState).toBe("waiting-reconnect"),
    );
    expect(readStartupRecovery(input.recovery)).toMatchObject({
      sessionId: "original-session",
      phase: "sending",
    });
    physicalSessionId = "replacement-session";
    Object.assign(gateway.snapshot, { client: { ...client } });
    startup.resumeRecovery();
    await vi.waitFor(() => expect(startup.get(key)?.initialTurn?.sendState).toBe("failed"));
    expect(turns).toBe(1);
    expect(request).toHaveBeenLastCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: key,
        sessionId: "original-session",
        expectedLeafEntryId: null,
        idempotencyKey: input.recovery.messageId,
      }),
      expect.anything(),
    );
    expect(startupCalls(request, "sessions.reclaim")).toHaveLength(0);
    startup.retry(key);
    await vi.waitFor(() => expect(startup.get(key)?.initialTurn?.sendState).toBe("failed"));
    expect(turns).toBe(1);
    expect(startupCalls(request, "sessions.dispatch")).toHaveLength(1);
    expect(startupCalls(request, "sessions.reclaim")).toHaveLength(0);
  });

  it.each(["rpc", "error", "timeout"] as const)(
    "delivery recovery rotates a cached %s rejection only on explicit Retry",
    async (failure) => {
      const rejection = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "send rejected",
      });
      const request = startupRequest({
        "sessions.describe": () =>
          Promise.resolve({
            session: { placement: createStartupPlacement("reclaimed", 3) },
          }),
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 2) }),
        "sessions.reclaim": () => Promise.resolve({ ok: true }),
        "chat.send": (payload?: Record<string, unknown>) => {
          if (payload?.idempotencyKey === "message-stable") {
            return failure === "rpc"
              ? Promise.reject(rejection)
              : Promise.resolve({ runId: "message-stable", status: failure });
          }
          return Promise.resolve({ runId: payload?.idempotencyKey, status: "started" });
        },
      });
      const { key, startup, input, chatSubmissions, client } =
        createPlacementStartupHarness(request);
      input.recovery = {
        ...input.recovery,
        target: { kind: "profile", profileId: "aws", machineClass: "fast" },
        attachments: [{ type: "file", mimeType: "text/plain", content: "SGk=" }],
      };
      writeSessionPlacementRecovery(input.recovery);
      startup.start(input);
      await vi.waitFor(() => expect(startup.get(key)?.phase).toBe("failed"));
      expect(chatSubmissions.readInitial(key, client)).toBeNull();
      expect(readStartupRecovery(input.recovery)).toMatchObject({
        phase: "paused",
        reason: "rejected",
        messageId: "message-stable",
      });
      startup.retry(key);
      startup.retry(key);
      const replacement = readStartupRecovery(input.recovery);
      expect(replacement?.messageId).not.toBe(input.recovery.messageId);
      await vi.waitFor(() => expect(startup.get(key)).toBeNull());
      const sends = startupCalls(request, "chat.send");
      expect(sends).toHaveLength(2);
      expect(sends[1]?.[1]).toMatchObject({
        sessionKey: key,
        message: input.recovery.message,
        attachments: input.recovery.attachments,
        idempotencyKey: expect.any(String),
      });
      expect(sends[1]?.[1]?.idempotencyKey).not.toBe("message-stable");
      expect(startupCalls(request, "sessions.dispatch").map(([, payload]) => payload)).toEqual(
        [1, 2].map(() => ({
          key,
          agentId: input.recovery.agentId,
          profileId: "aws",
          machineClass: "fast",
        })),
      );
      expect(chatSubmissions.readInitial(key, client)?.pendingRunId).toBe(
        sends[1]?.[1]?.idempotencyKey,
      );
    },
  );

  it.each(["in_flight", "ok"])(
    "resends a restored first message with its original key and accepts duplicate %s",
    async (status) => {
      const request = startupRequest({
        "chat.send": () => Promise.resolve({ runId: "message-stable", status }),
      });
      const { key, startup, input, chatSubmissions, client } =
        createPlacementStartupHarness(request);
      const attachments = [
        { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" },
      ];
      input.recovery = { ...input.recovery, phase: "sending", attachments };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      await vi.waitFor(() => expect(startup.get(key)).toBeNull());
      expect(startupMethods(request)).toEqual(["chat.send"]);
      expect(startupCalls(request, "chat.send")[0]?.[1]).toMatchObject({
        sessionKey: key,
        message: input.recovery.message,
        idempotencyKey: input.recovery.messageId,
        attachments,
      });
      expect(readStartupRecovery(input.recovery)).toBeNull();
      expect(chatSubmissions.readInitial(key, client)?.pendingRunId).toBe(input.recovery.messageId);
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "keeps interrupted first input pending and reconciles %s on the next hello",
    async (outcome) => {
      const request = startupRequest({
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 1) }),
        "chat.send": () => Promise.reject(new Error("socket closed after send")),
      });
      const { key, startup, input, client, gateway, chatSubmissions } =
        createPlacementStartupHarness(request);
      startup.start(input);
      await vi.waitFor(() =>
        expect(startup.get(key)?.initialTurn?.sendState).toBe("waiting-reconnect"),
      );
      expect(startup.get(key)?.retryable).not.toBe(true);
      expect(readStartupRecovery(input.recovery)).toMatchObject({
        phase: "sending",
        messageId: input.recovery.messageId,
      });
      const replacementRequest = startupRequest({
        "chat.send": () =>
          outcome === "accepted"
            ? Promise.resolve({ runId: input.recovery.messageId, status: "in_flight" })
            : Promise.reject(
                new GatewayRequestError({
                  code: "INVALID_REQUEST",
                  message: "send rejected",
                }),
              ),
        "sessions.reclaim": () => Promise.resolve({ ok: true }),
      });
      const transition = (snapshot: ApplicationGateway["snapshot"]) => {
        Object.assign(gateway, { snapshot });
        for (const [listener] of vi.mocked(gateway.subscribe).mock.calls) {
          listener(snapshot);
        }
      };
      client.recoveryScopeReady = false;
      transition({ ...gateway.snapshot, phase: "reconnecting" });
      const replacement = { ...client, request: replacementRequest, recoveryScopeReady: true };
      transition({ ...gateway.snapshot, phase: "connected", client: replacement as never });
      await vi.waitFor(() => {
        if (outcome === "accepted") {
          expect(startup.get(key)).toBeNull();
          expect(chatSubmissions.readInitial(key, replacement)?.pendingRunId).toBe(
            input.recovery.messageId,
          );
        } else {
          expect(startup.get(key)).toMatchObject({
            phase: "failed",
            action: "retry",
            initialTurn: { sendState: "failed" },
          });
        }
      });
      expect(startupCalls(replacementRequest, "chat.send")[0]?.[1]).toMatchObject({
        idempotencyKey: input.recovery.messageId,
        message: input.recovery.message,
      });
      expect(startupCalls(request, "chat.send")).toHaveLength(1);
      expect(startupCalls(replacementRequest, "chat.send")).toHaveLength(1);
      expect(startupCalls(replacementRequest, "sessions.dispatch")).toHaveLength(0);
      expect(startupCalls(replacementRequest, "chat.history")).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "discards pending first input locally (persistent=%s)",
    async (persistRecovery) => {
      const request = startupRequest({
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 1) }),
        "chat.send": () => Promise.reject(new Error("socket closed after send")),
      });
      const { key, startup, input } = createPlacementStartupHarness(request);
      if (!persistRecovery) {
        sessionStorage.clear();
      }
      startup.start({ ...input, persistRecovery });
      await vi.waitFor(() =>
        expect(startup.get(key)?.initialTurn?.sendState).toBe("waiting-reconnect"),
      );
      startup.discard(key);
      expect(startup.get(key)).toBeNull();
      expect(startup.hasPendingTurn(key)).toBe(false);
      expect(readStartupRecovery(input.recovery)).toBeNull();
      startup.resumeRecovery();
      await flushStartupMicrotasks();
      expect(startupMethods(request)).toEqual(["sessions.dispatch", "chat.send"]);
    },
  );

  it("discards retained first input before its lazy runtime can send", async () => {
    const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
    const request = vi.fn();
    const { key, startup, input } = createPlacementStartupHarness(request, {
      loadRuntime: () => moduleLoad.promise,
    });
    startup.start(input);
    expect(startup.get(key)?.initialTurn?.text).toBe(input.recovery.message);
    startup.discard(key);
    await vi.waitFor(() => expect(startup.get(key)).toBeNull());
    expect(readStartupRecovery(input.recovery)).toBeNull();
    moduleLoad.resolve({ default: createRuntime });
    await flushStartupMicrotasks();
    expect(startup.hasPendingTurn(key)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["message", "credential"])(
    "ignores a stale send acknowledgement after %s ownership changes",
    async (changed) => {
      const send = createDeferred<unknown>();
      const request = startupRequest({ "chat.send": () => send.promise });
      const { key, startup, input, client, chatSubmissions } =
        createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      await vi.waitFor(() => expect(startupCalls(request, "chat.send")).toHaveLength(1));
      const retained =
        changed === "message"
          ? { ...input.recovery, messageId: "new-owner", message: "new submission" }
          : input.recovery;
      writeSessionPlacementRecovery(retained);
      if (changed === "credential") {
        client.recoveryScope = "principal-b";
      }
      expect(startup.get(key)).toBeNull();
      send.resolve({ runId: input.recovery.messageId, status: "ok" });
      await flushStartupMicrotasks();
      expect(readStartupRecovery(input.recovery)).toEqual(retained);
      expect(chatSubmissions.readInitial(key, client)).toBeNull();
      expect(startupMethods(request)).toEqual(["chat.send"]);
    },
  );
});

describe("placement startup reconnect", () => {
  function transition(gateway: ApplicationGateway, snapshot: ApplicationGateway["snapshot"]) {
    Object.assign(gateway, { snapshot });
    for (const [listener] of vi.mocked(gateway.subscribe).mock.calls) {
      listener(snapshot);
    }
  }

  beforeEach(() => sessionStorage.clear());
  afterEach(() => restoreMocksAndGlobals());

  describe("initial turn ownership through disconnect", () => {
    it("restores paused content without effects after storage failure and client replacement", async () => {
      const request = vi.fn(() => {
        blockStorageWrites();
        return Promise.reject(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "target unavailable" }),
        );
      });
      const { key, startup, input, client, gateway } = createPlacementStartupHarness(request);
      sessionStorage.clear();
      startup.start(input);
      await vi.waitFor(() => expect(startup.get(key)?.phase).toBe("failed"));
      client.recoveryScopeReady = false;
      transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
      const reconnecting = startup.get(key);
      expect(reconnecting).toMatchObject({
        phase: "reconnecting",
        retryable: false,
        initialTurn: {
          text: input.recovery.message,
          sendRunId: input.recovery.messageId,
          sendState: "waiting-reconnect",
        },
      });
      expect(chatStartupStatusLabel(null, reconnecting)).toBe("Reconnecting…");
      expect(startup.hasPendingTurn(key)).toBe(true);
      startup.retry(key);
      const replacement = { ...client, recoveryScopeReady: true };
      transition(gateway, {
        ...gateway.snapshot,
        client: replacement as never,
        phase: "connected",
      });
      await flushStartupMicrotasks();
      expect(startup.get(key)).toMatchObject({
        phase: "failed",
        startedAt: input.createdAt,
        initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
        action: "retry",
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(sessionStorage.length).toBe(0);
      startup.dispose();
    });

    it("keeps an explicit Start while its lazy runtime loads offline", async () => {
      const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
      const request = vi.fn((method: string) =>
        method === "sessions.dispatch"
          ? Promise.reject(
              new GatewayRequestError({ code: "INVALID_REQUEST", message: "target unavailable" }),
            )
          : Promise.reject(new Error(`unexpected ${method}`)),
      );
      const { key, startup, input, client, gateway } = createPlacementStartupHarness(request, {
        loadRuntime: () => moduleLoad.promise,
      });
      sessionStorage.clear();
      startup.start({ ...input, persistRecovery: false });
      client.recoveryScopeReady = false;
      transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
      expect(startup.get(key)).toMatchObject({
        phase: "reconnecting",
        retryable: false,
        initialTurn: { text: input.recovery.message, sendState: "waiting-reconnect" },
      });
      moduleLoad.resolve({ default: createRuntime });
      await flushStartupMicrotasks();
      expect(request).not.toHaveBeenCalled();
      expect(startup.hasPendingTurn(key)).toBe(true);
      expect(startup.get(key)?.initialTurn?.text).toBe(input.recovery.message);
      const replacement = { ...client, recoveryScopeReady: true };
      transition(gateway, {
        ...gateway.snapshot,
        client: replacement as never,
        phase: "connected",
      });
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "sessions.dispatch",
          expect.objectContaining({ key, profileId: "aws" }),
        ),
      );
      await vi.waitFor(() => expect(startup.get(key)?.phase).toBe("failed"));
      expect(sessionStorage.length).toBe(0);
      startup.dispose();
    });
    it.each(["credentials", "hello-before-recovery", "principal"])(
      "fences a replaced %s owner while retaining its original storage",
      async (change) => {
        const request = vi
          .fn()
          .mockRejectedValue(
            new GatewayRequestError({ code: "INVALID_REQUEST", message: "target unavailable" }),
          );
        const { key, startup, input, client, gateway } = createPlacementStartupHarness(request);
        Object.assign(gateway.snapshot, { selfUser: { id: "user-a" } });
        startup.start(input);
        await vi.waitFor(() => expect(startup.get(key)?.phase).toBe("failed"));
        if (change === "credentials") {
          Object.assign(gateway, { connectionRevision: 1 });
        }
        if (change === "hello-before-recovery") {
          client.recoveryScopeReady = false;
          Object.assign(gateway.snapshot.hello!, { auth: { recoveryScope: "principal-b" } });
        }
        if (change === "principal") {
          client.recoveryScopeReady = false;
          Object.assign(gateway.snapshot, { selfUser: { id: "user-b" } });
        }
        expect(startup.get(key)).toBeNull();
        expect(startup.hasPendingTurn(key)).toBe(false);
        startup.retry(key);
        await flushStartupMicrotasks();
        expect(request).toHaveBeenCalledTimes(1);
        expect(sessionStorage.length).toBe(1);
        startup.dispose();
      },
    );

    it.each([false, true])(
      "claims restored ownership during an offline runtime load (credentials changed: %s)",
      async (credentialsChanged) => {
        const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
        const request = vi.fn();
        const { key, startup, input, gateway, client } = createPlacementStartupHarness(request, {
          loadRuntime: () => moduleLoad.promise,
        });
        writeSessionPlacementRecovery({
          ...input.recovery,
          phase: "paused",
          reason: "not-sent",
          error: "target unavailable",
        });
        startup.resumeRecovery();
        expect(startup.hasPendingTurn(key)).toBe(true);
        client.recoveryScopeReady = false;
        if (credentialsChanged) {
          Object.assign(gateway, { connectionRevision: 1 });
        }
        transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
        expect(startup.hasPendingTurn(key)).toBe(!credentialsChanged);
        expect(startup.get(key)).toBeNull();
        moduleLoad.resolve({ default: createRuntime });
        await flushStartupMicrotasks();
        expect(startup.hasPendingTurn(key)).toBe(!credentialsChanged);
        if (credentialsChanged) {
          client.recoveryScope = "principal-b";
        }
        client.recoveryScopeReady = true;
        transition(gateway, { ...gateway.snapshot, phase: "connected" });
        await flushStartupMicrotasks();
        expect(request).not.toHaveBeenCalled();
        expect(startup.hasPendingTurn(key)).toBe(!credentialsChanged);
        if (!credentialsChanged) {
          expect(startup.get(key)?.initialTurn?.text).toBe(input.recovery.message);
        }
        startup.dispose();
      },
    );

    it("releases a temporary key hold when the loaded owner rejects an invalid record", async () => {
      const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
      const request = vi.fn();
      const { startup, input } = createPlacementStartupHarness(request, {
        loadRuntime: () => moduleLoad.promise,
      });
      const { gatewayUrl, recoveryScope, sessionKey } = input.recovery;
      sessionStorage.setItem(
        sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey),
        "{}",
      );
      const holds: boolean[] = [];
      startup.subscribe(() => holds.push(startup.hasPendingTurn(sessionKey)));
      startup.resumeRecovery();
      expect(startup.hasPendingTurn(sessionKey)).toBe(true);
      moduleLoad.resolve({ default: createRuntime });
      await flushStartupMicrotasks();
      expect(holds.at(-1)).toBe(false);
      expect(startup.hasPendingTurn(sessionKey)).toBe(false);
      expect(startup.get(sessionKey)).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(sessionStorage.length).toBe(0);
      startup.dispose();
    });

    it("keeps interrupted pending ownership until reconciliation and retires only accepted delivery", async () => {
      const dispatch = createDeferred<unknown>();
      const request = startupRequest({
        "sessions.dispatch": () => dispatch.promise,
        "sessions.describe": () =>
          Promise.resolve({ session: { placement: createStartupPlacement("active", 2) } }),
        "chat.send": () => Promise.resolve({ status: "started" }),
      });
      const { key, startup, input, client, gateway } = createPlacementStartupHarness(request);
      startup.start(input);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      client.recoveryScopeReady = false;
      transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
      dispatch.resolve({ placement: createStartupPlacement("active", 2) });
      await flushStartupMicrotasks();
      expect(startup.hasPendingTurn(key)).toBe(true);
      expect(startup.get(key)).toMatchObject({
        phase: "reconnecting",
        initialTurn: { text: input.recovery.message, sendState: "waiting-reconnect" },
      });
      expect(request).toHaveBeenCalledTimes(1);
      client.recoveryScopeReady = true;
      transition(gateway, { ...gateway.snapshot, phase: "connected" });
      expect(startup.get(key)?.startedAt).toBe(input.createdAt);
      await vi.waitFor(() => expect(startup.hasPendingTurn(key)).toBe(false));
      expect(startupMethods(request)).toEqual([
        "sessions.dispatch",
        "sessions.describe",
        "chat.send",
      ]);
      expect(sessionStorage.length).toBe(0);
      startup.dispose();
    });
    it("keeps accepted display when client replacement follows recovery retirement", async () => {
      const send = createDeferred<unknown>();
      const request = startupRequest({
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 2) }),
        "chat.send": () => send.promise,
      });
      const { key, startup, input, client, gateway, chatSubmissions } =
        createPlacementStartupHarness(request);
      startup.start(input);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.send", expect.anything(), expect.anything()),
      );
      const storage = sessionStorage;
      const remove = storage.removeItem.bind(storage);
      const recoveryKey = sessionPlacementRecoveryExactStorageKey(
        input.recovery.gatewayUrl,
        input.recovery.recoveryScope,
        key,
      );
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation((storageKey) => {
        remove(storageKey);
        if (storageKey === recoveryKey) {
          queueMicrotask(() => {
            client.recoveryScopeReady = false;
            transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
            const replacement = { ...client, recoveryScopeReady: true };
            transition(gateway, {
              ...gateway.snapshot,
              phase: "connected",
              client: replacement as never,
            });
          });
        }
      });
      const visible: boolean[] = [];
      const stop = startup.subscribe(() =>
        visible.push(
          Boolean(
            startup.get(key)?.initialTurn ||
            chatSubmissions.readInitial(key, gateway.snapshot.client),
          ),
        ),
      );
      try {
        send.resolve({ status: "started" });
        await vi.waitFor(() =>
          expect(chatSubmissions.readInitial(key, gateway.snapshot.client)?.pendingRunId).toBe(
            input.recovery.messageId,
          ),
        );
        expect(visible).not.toContain(false);
        expect(startup.hasPendingTurn(key)).toBe(false);
        const attempts = startupCalls(request, "chat.send");
        expect(attempts).toHaveLength(2);
        expect(attempts[1]?.[1]).toEqual(attempts[0]?.[1]);
      } finally {
        stop();
        startup.dispose();
      }
    });

    it.each(["reclaim", "archive", "delete"])(
      "retains an incognito %s failure that settles after same-credential reconnect",
      async (failure) => {
        const dispatch = createDeferred<unknown>();
        const request = startupRequest({
          "sessions.dispatch": () => dispatch.promise,
          "sessions.reclaim": () =>
            failure === "reclaim"
              ? Promise.reject(new Error("cleanup unavailable"))
              : Promise.resolve({ ok: true }),
          "sessions.describe": () =>
            Promise.resolve({ session: { sessionId: "temporary-session" } }),
          "sessions.patch": (params?: { archived?: boolean }) =>
            failure === "archive" && params?.archived
              ? Promise.reject(new Error("cleanup unavailable"))
              : Promise.resolve({ ok: true }),
          "sessions.delete": () => Promise.reject(new Error("cleanup unavailable")),
        });
        const { key, startup, input, client, gateway } = createPlacementStartupHarness(request);
        sessionStorage.clear();
        startup.start({ ...input, persistRecovery: false });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        client.recoveryScopeReady = false;
        transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
        transition(gateway, {
          ...gateway.snapshot,
          client: { ...client, recoveryScopeReady: true } as never,
          phase: "connected",
        });
        dispatch.resolve({ placement: createStartupPlacement("active", 2) });
        await vi.waitFor(() =>
          expect(startup.get(key)).toMatchObject({
            phase: "failed",
            error: "cleanup unavailable",
            retryable: true,
            initialTurn: { text: input.recovery.message },
          }),
        );
        expect(startup.hasPendingTurn(key)).toBe(true);
        expect(startupMethods(request)).toEqual(
          failure === "reclaim"
            ? ["sessions.dispatch", "sessions.reclaim"]
            : [
                "sessions.dispatch",
                "sessions.reclaim",
                "sessions.describe",
                "sessions.patch",
                ...(failure === "delete" ? ["sessions.delete", "sessions.patch"] : []),
              ],
        );
        expect(sessionStorage.length).toBe(0);
        startup.dispose();
      },
    );
  });
});
