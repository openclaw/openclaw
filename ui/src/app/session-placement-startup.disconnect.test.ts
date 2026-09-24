import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import { writeSessionPlacementRecovery } from "../lib/sessions/session-placement-recovery.ts";
import { chatStartupStatusLabel } from "../pages/chat/chat-run-startup.ts";
import type { ApplicationGateway } from "./gateway.ts";
import createRuntime from "./session-placement-startup.runtime.ts";
import {
  blockStorageWrites,
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";

function transition(gateway: ApplicationGateway, snapshot: ApplicationGateway["snapshot"]) {
  Object.assign(gateway, { snapshot });
  for (const [listener] of vi.mocked(gateway.subscribe).mock.calls) {
    listener(snapshot);
  }
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("initial turn ownership through disconnect", () => {
  it.each([
    { persistent: true, storageFails: false, replacementClient: true },
    { persistent: false, storageFails: false, replacementClient: true },
    { persistent: false, storageFails: false, replacementClient: false },
    { persistent: true, storageFails: true, replacementClient: true },
  ])(
    "restores paused content without effects ($persistent, storage failure: $storageFails, replacement: $replacementClient)",
    async ({ persistent, storageFails, replacementClient }) => {
      const request = vi.fn(() => {
        if (storageFails) {
          blockStorageWrites();
        }
        return Promise.reject(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "target unavailable" }),
        );
      });
      const { startup, input, client, gateway } = createPlacementStartupHarness(request);
      sessionStorage.clear();
      startup.start({ ...input, persistRecovery: persistent });
      await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"));
      client.recoveryScopeReady = false;
      transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
      const reconnecting = startup.get(input.recovery.sessionKey);
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
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
      startup.retry(input.recovery.sessionKey);
      const replacement = replacementClient ? { ...client, recoveryScopeReady: true } : client;
      replacement.recoveryScopeReady = true;
      transition(gateway, {
        ...gateway.snapshot,
        client: replacement as never,
        phase: "connected",
      });
      await flushStartupMicrotasks();
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        startedAt: input.createdAt,
        initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
        action: "retry",
      });
      expect(request).toHaveBeenCalledTimes(1);
      if (!persistent || storageFails) {
        expect(sessionStorage.length).toBe(0);
      }
      startup.dispose();
    },
  );

  it("keeps an explicit Start while its lazy runtime loads offline", async () => {
    const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
    const request = vi.fn((method: string) =>
      method === "sessions.dispatch"
        ? Promise.reject(
            new GatewayRequestError({ code: "INVALID_REQUEST", message: "target unavailable" }),
          )
        : Promise.reject(new Error(`unexpected ${method}`)),
    );
    const { startup, input, client, gateway } = createPlacementStartupHarness(request, {
      loadRuntime: () => moduleLoad.promise,
    });
    sessionStorage.clear();
    startup.start({ ...input, persistRecovery: false });
    client.recoveryScopeReady = false;
    transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "reconnecting",
      retryable: false,
      initialTurn: { text: input.recovery.message, sendState: "waiting-reconnect" },
    });
    moduleLoad.resolve({ default: createRuntime });
    await flushStartupMicrotasks();
    expect(request).not.toHaveBeenCalled();
    expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
    expect(startup.get(input.recovery.sessionKey)?.initialTurn?.text).toBe(input.recovery.message);
    const replacement = { ...client, recoveryScopeReady: true };
    transition(gateway, { ...gateway.snapshot, client: replacement as never, phase: "connected" });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.dispatch",
        expect.objectContaining({ key: input.recovery.sessionKey, profileId: "aws" }),
      ),
    );
    await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"));
    expect(sessionStorage.length).toBe(0);
    startup.dispose();
  });
  it.each(["credentials", "hello", "hello-before-recovery", "principal", "gateway", "message"])(
    "fences a replaced %s owner while retaining its original storage",
    async (change) => {
      const request = vi
        .fn()
        .mockRejectedValue(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "target unavailable" }),
        );
      const { startup, input, client, gateway } = createPlacementStartupHarness(request);
      Object.assign(gateway.snapshot, { selfUser: { id: "user-a" } });
      startup.start(input);
      await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"));
      if (change === "credentials") {
        Object.assign(gateway, { connectionRevision: 1 });
      }
      if (change === "hello") {
        client.recoveryScope = "principal-b";
      }
      if (change === "hello-before-recovery") {
        client.recoveryScopeReady = false;
        Object.assign(gateway.snapshot.hello!, { auth: { recoveryScope: "principal-b" } });
      }
      if (change === "principal") {
        client.recoveryScopeReady = false;
        Object.assign(gateway.snapshot, { selfUser: { id: "user-b" } });
      }
      if (change === "gateway") {
        Object.assign(gateway.connection, { gatewayUrl: "ws://other.example" });
      }
      if (change === "message") {
        writeSessionPlacementRecovery({ ...input.recovery, messageId: "newer" });
      }
      expect(startup.get(input.recovery.sessionKey)).toBeNull();
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
      startup.retry(input.recovery.sessionKey);
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
      const { startup, input, gateway, client } = createPlacementStartupHarness(request, {
        loadRuntime: () => moduleLoad.promise,
      });
      writeSessionPlacementRecovery({
        ...input.recovery,
        phase: "paused",
        reason: "not-sent",
        error: "target unavailable",
      });
      startup.resumeRecovery();
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
      client.recoveryScopeReady = false;
      if (credentialsChanged) {
        Object.assign(gateway, { connectionRevision: 1 });
      }
      transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(!credentialsChanged);
      expect(startup.get(input.recovery.sessionKey)).toBeNull();
      moduleLoad.resolve({ default: createRuntime });
      await flushStartupMicrotasks();
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(!credentialsChanged);
      if (credentialsChanged) {
        client.recoveryScope = "principal-b";
      }
      client.recoveryScopeReady = true;
      transition(gateway, { ...gateway.snapshot, phase: "connected" });
      await flushStartupMicrotasks();
      expect(request).not.toHaveBeenCalled();
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(!credentialsChanged);
      if (!credentialsChanged) {
        expect(startup.get(input.recovery.sessionKey)?.initialTurn?.text).toBe(
          input.recovery.message,
        );
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
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return dispatch.promise;
      }
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: createStartupPlacement("active", 2) } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ status: "started" });
      }
      throw new Error(`unexpected ${method}`);
    });
    const { startup, input, client, gateway } = createPlacementStartupHarness(request);
    startup.start(input);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    client.recoveryScopeReady = false;
    transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
    dispatch.resolve({ placement: createStartupPlacement("active", 2) });
    await flushStartupMicrotasks();
    expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "reconnecting",
      initialTurn: { text: input.recovery.message, sendState: "waiting-reconnect" },
    });
    expect(request).toHaveBeenCalledTimes(1);
    client.recoveryScopeReady = true;
    transition(gateway, { ...gateway.snapshot, phase: "connected" });
    expect(startup.get(input.recovery.sessionKey)?.startedAt).toBe(input.createdAt);
    await vi.waitFor(() => expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.dispatch",
      "sessions.describe",
      "sessions.send",
    ]);
    expect(sessionStorage.length).toBe(0);
    startup.dispose();
  });
  it.each([false, true])(
    "keeps accepted display when reconnect follows recovery retirement (replacement client: %s)",
    async (replaceClient) => {
      const send = createDeferred<unknown>();
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 2) });
        }
        if (method === "sessions.send") {
          return send.promise;
        }
        if (method === "chat.history") {
          return Promise.resolve({
            messages: [
              {
                role: "user",
                content: "fix the cloud task",
                __openclaw: { id: "accepted-user", idempotencyKey: "message-stable:user" },
              },
            ],
          });
        }
        throw new Error(`unexpected ${method}`);
      });
      const { startup, input, client, gateway, chatSubmissions } =
        createPlacementStartupHarness(request);
      startup.start(input);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("sessions.send", expect.anything()),
      );
      const storage = sessionStorage;
      const remove = storage.removeItem.bind(storage);
      const recoveryKey = sessionPlacementRecoveryExactStorageKey(
        input.recovery.gatewayUrl,
        input.recovery.recoveryScope,
        input.recovery.sessionKey,
      );
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
        remove(key);
        if (key === recoveryKey) {
          queueMicrotask(() => {
            client.recoveryScopeReady = false;
            transition(gateway, { ...gateway.snapshot, phase: "reconnecting" });
            const replacement = replaceClient ? { ...client } : client;
            replacement.recoveryScopeReady = true;
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
            startup.get(input.recovery.sessionKey)?.initialTurn ||
            chatSubmissions.readInitial(input.recovery.sessionKey, gateway.snapshot.client),
          ),
        ),
      );
      try {
        send.resolve({ status: "started" });
        await vi.waitFor(() =>
          expect(
            chatSubmissions.readInitial(input.recovery.sessionKey, gateway.snapshot.client)
              ?.pendingRunId,
          ).toBe(input.recovery.messageId),
        );
        expect(visible).not.toContain(false);
        expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
      } finally {
        stop();
        startup.dispose();
      }
    },
  );

  it.each(["reclaim", "archive", "delete"])(
    "retains an incognito %s failure that settles after same-credential reconnect",
    async (failure) => {
      const dispatch = createDeferred<unknown>();
      const request = vi.fn((method: string, params?: { archived?: boolean }) => {
        if (method === "sessions.dispatch") {
          return dispatch.promise;
        }
        if (method === "sessions.reclaim") {
          return failure === "reclaim"
            ? Promise.reject(new Error("cleanup unavailable"))
            : Promise.resolve({ ok: true });
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { sessionId: "temporary-session" } });
        }
        if (method === "sessions.patch") {
          return failure === "archive" && params?.archived
            ? Promise.reject(new Error("cleanup unavailable"))
            : Promise.resolve({ ok: true });
        }
        if (method === "sessions.delete") {
          return Promise.reject(new Error("cleanup unavailable"));
        }
        throw new Error(`unexpected ${method}`);
      });
      const { startup, input, client, gateway } = createPlacementStartupHarness(request);
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
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          error: "cleanup unavailable",
          retryable: true,
          initialTurn: { text: input.recovery.message },
        }),
      );
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
      expect(request.mock.calls.map(([method]) => method)).toEqual(
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
