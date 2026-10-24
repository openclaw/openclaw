import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import { writeSessionPlacementRecovery } from "../lib/sessions/session-placement-recovery.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "../pages/chat/chat-pending-inputs.ts";
import { chatStartupStatusLabel } from "../pages/chat/chat-run-startup.ts";
import { buildChatItems } from "../pages/chat/chat-thread-build.ts";
import { admitChatSubmission, reduceChatSessionProjection } from "../pages/chat/history-merge.ts";
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
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

describe("application placement delivery recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
        "sessions.send": (payload?: Record<string, unknown>) => {
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
      const sends = startupCalls(request, "sessions.send");
      expect(sends).toHaveLength(2);
      expect(sends[1]?.[1]).toMatchObject({
        key,
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

  it("delivery recovery checks uncertain sending without mutating placement", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({ messages: [] });
      }
      return Promise.resolve({ status: "started" });
    });
    const { key, startup, input, dependencies } = createPlacementStartupHarness(request);
    const attachments = [
      { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" },
    ];
    input.recovery = { ...input.recovery, phase: "sending", attachments };
    writeSessionPlacementRecovery(input.recovery);
    startup.resumeRecovery();
    await vi.waitFor(() =>
      expect(startup.get(key)).toMatchObject({
        phase: "failed",
        action: "check-delivery",
        initialTurn: {
          text: input.recovery.message,
          sendState: "unconfirmed",
          attachments: [{ dataUrl: "data:text/plain;base64,SGk=" }],
        },
      }),
    );
    startup.retry(key);
    startup.retry(key);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: key, limit: 1000 }),
    );
    expect(readStartupRecovery(input.recovery)).toMatchObject({
      phase: "paused",
      reason: "unconfirmed",
      messageId: input.recovery.messageId,
      attachments,
    });
    startup.dispose();
    const reloaded = createApplicationPlacementStartup(dependencies);
    reloaded.resumeRecovery();
    try {
      await vi.waitFor(() =>
        expect(reloaded.get(key)).toMatchObject({
          action: "check-delivery",
          initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
        }),
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      reloaded.dispose();
    }
  });

  it.each(["retained-outside-page", "assistant", "same-text", "unavailable"])(
    "delivery recovery settles only authoritative input custody (%s)",
    async (evidence) => {
      const delivered = evidence === "retained-outside-page";
      const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
        if (method === "chat.history") {
          if (evidence === "unavailable") {
            return Promise.reject(new Error("history unavailable"));
          }
          return Promise.resolve({
            sessionId: "physical-cloud-session",
            messages: delivered
              ? []
              : [
                  {
                    role: evidence === "assistant" ? "assistant" : "user",
                    content: [{ type: "text", text: "fix the cloud task" }],
                    __openclaw: {
                      idempotencyKey:
                        evidence === "same-text" ? "other:user" : "message-stable:user",
                    },
                  },
                ],
            pendingInputs: {
              items: delivered
                ? Array.from({ length: 20 }, (_, index) => ({
                    id: `newer-${index}`,
                    runId: `newer-${index}`,
                    state: "interrupted",
                    acceptedAt: 1_001 + index,
                    message: { role: "user", content: `newer-${index}` },
                  }))
                : [],
              total: delivered ? 21 : 0,
            },
            ...(delivered &&
            Array.isArray(payload?.inputRunIds) &&
            payload.inputRunIds.includes("message-stable")
              ? {
                  inputReceipts: [{ runId: "message-stable", state: "pending" }],
                }
              : {}),
          });
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { key, startup, input, chatSubmissions, client } =
        createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
      );
      await vi.waitFor(() => {
        if (delivered) {
          expect(startup.get(key)).toBeNull();
          expect(startup.hasPendingTurn(key)).toBe(false);
          const handoff = chatSubmissions.readInitial(key, client);
          expect(handoff?.pendingRunId).toBe(input.recovery.messageId);
        } else {
          expect(startup.get(key)).toMatchObject({
            phase: "failed",
            action: "check-delivery",
            initialTurn: { text: input.recovery.message },
          });
        }
      });
      expect(startupMethods(request)).toEqual(["chat.history"]);
      const stored = readStartupRecovery(input.recovery);
      if (delivered) {
        expect(stored).toBeNull();
      } else {
        expect(stored).toMatchObject({
          phase: "paused",
          reason: "unconfirmed",
          messageId: input.recovery.messageId,
        });
      }
    },
  );

  it.each([
    { order: "pane-first", receipt: "pending" },
    { order: "recovery-first", receipt: "pending" },
    { order: "recovery-first", receipt: "consumed" },
  ] as const)(
    "keeps exactly one initial prompt when $receipt custody arrives $order",
    async ({ order, receipt }) => {
      const history = createDeferred<unknown>();
      const request = vi.fn(() => history.promise);
      const { key, startup, input, gateway, chatSubmissions } =
        createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      const pane = makeChatHost({
        sessionKey: key,
        currentSessionId: "physical-cloud-session",
        client: gateway.snapshot.client,
        chatSubmissions,
      });
      const page = {
        items: [
          {
            id: "accepted-initial-input",
            runId: input.recovery.messageId,
            state: "queued" as const,
            acceptedAt: input.createdAt,
            message: {
              role: "user",
              content: [{ type: "text", text: input.recovery.message }],
              timestamp: input.createdAt,
              __openclaw: { id: "pending:accepted-initial-input" },
            },
          },
        ],
        total: 1,
      };
      const visibleMessages = () => {
        const initialTurn = startup.get(pane.sessionKey)?.initialTurn;
        return buildChatItems({
          paneId: `startup-custody-${order}`,
          sessionKey: pane.sessionKey,
          messages: pane.chatMessages,
          pendingInputs: getChatPendingInputs(pane)?.page.items,
          queue: initialTurn ? [initialTurn] : [],
          initialTurnId: initialTurn?.id,
          toolMessages: [],
          streamSegments: [],
          stream: null,
          streamStartedAt: null,
          showToolCalls: true,
        }).flatMap((item) =>
          item.kind === "group" && item.role === "user"
            ? item.messages.map((entry) => entry.message)
            : [],
        );
      };
      const publications: unknown[][] = [];
      const stop = startup.subscribe(() => {
        admitChatSubmission(pane, getChatPendingInputs(pane)?.page.items);
        publications.push(visibleMessages());
      });
      try {
        startup.resumeRecovery();
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        expect(visibleMessages()).toHaveLength(1);
        publications.length = 0;
        if (order === "pane-first") {
          applyChatPendingInputs(pane, page);
          expect(visibleMessages()).toHaveLength(1);
        }
        history.resolve({
          sessionId: pane.currentSessionId,
          messages: [],
          pendingInputs: receipt === "pending" ? page : { items: [], total: 0 },
          inputReceipts: [
            {
              runId: input.recovery.messageId,
              state: receipt,
              ...(receipt === "consumed" ? { consumedByEventId: "aggregate-input" } : {}),
            },
          ],
        });
        await vi.waitFor(() => expect(startup.get(pane.sessionKey)).toBeNull());
        expect(visibleMessages()).toHaveLength(1);
        expect(publications.length).toBeGreaterThan(0);
        for (const messages of publications) {
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({
            content: [{ type: "text", text: input.recovery.message }],
          });
        }
        if (receipt === "consumed") {
          const aggregate = {
            role: "user",
            content: [{ type: "text", text: input.recovery.message }],
            __openclaw: {
              id: "aggregate-input",
              seq: 1,
              idempotencyKey: "followup-collect:session:batch",
            },
          };
          // The pane requested this snapshot before the handoff supplied inputRunIds.
          reduceChatSessionProjection(pane, { type: "snapshotLoaded", messages: [aggregate] });
          applyChatPendingInputs(pane, { items: [], total: 0 });
          expect(visibleMessages()).toEqual([aggregate]);
        } else {
          applyChatPendingInputs(pane, page);
          expect(visibleMessages()).toEqual(page.items.map((item) => item.message));
          expect(pane.chatMessages).toEqual([]);
        }
        expect(request).toHaveBeenCalledOnce();
      } finally {
        stop();
        startup.dispose();
      }
    },
  );

  it.each(["message", "credential"])(
    "delivery recovery fences a stale observation after %s ownership changes",
    async (changed) => {
      const history = createDeferred<{ messages: unknown[] }>();
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return history.promise;
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { key, startup, input, client, chatSubmissions } =
        createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
      );
      const retained =
        changed === "message"
          ? { ...input.recovery, messageId: "new-owner", message: "new submission" }
          : input.recovery;
      writeSessionPlacementRecovery(retained);
      if (changed === "credential") {
        client.recoveryScope = "principal-b";
      }
      expect(startup.get(key)).toBeNull();
      history.resolve({
        messages: [{ role: "user", __openclaw: { idempotencyKey: "message-stable:user" } }],
      });
      await flushStartupMicrotasks();
      expect(readStartupRecovery(input.recovery)).toEqual(retained);
      expect(chatSubmissions.readInitial(key, client)).toBeNull();
      expect(startupMethods(request)).toEqual(["chat.history"]);
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
        "sessions.send": () => Promise.resolve({ status: "started" }),
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
        "sessions.send",
      ]);
      expect(sessionStorage.length).toBe(0);
      startup.dispose();
    });
    it("keeps accepted display when client replacement follows recovery retirement", async () => {
      const send = createDeferred<unknown>();
      const request = startupRequest({
        "sessions.dispatch": () =>
          Promise.resolve({ placement: createStartupPlacement("active", 2) }),
        "sessions.send": () => send.promise,
        "chat.history": () =>
          Promise.resolve({
            messages: [
              {
                role: "user",
                content: "fix the cloud task",
                __openclaw: { id: "accepted-user", idempotencyKey: "message-stable:user" },
              },
            ],
          }),
      });
      const { key, startup, input, client, gateway, chatSubmissions } =
        createPlacementStartupHarness(request);
      startup.start(input);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("sessions.send", expect.anything(), expect.anything()),
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
        expect(startupCalls(request, "sessions.send")).toHaveLength(1);
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
