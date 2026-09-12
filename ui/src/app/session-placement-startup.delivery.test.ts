import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import {
  createPlacementStartupHarness,
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

  it.each([
    "connected",
    "disconnect",
    "late-rejection",
    "during-check",
    "storage-unavailable",
  ] as const)(
    "retains the original send diagnostic through repeated delivery checks (%s)",
    async (timing) => {
      const send = createDeferred<unknown>();
      const history = createDeferred<unknown>();
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 2) });
        }
        if (method === "sessions.send") {
          return send.promise;
        }
        if (method === "chat.history") {
          return timing === "during-check" ? history.promise : Promise.resolve({ messages: [] });
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, gateway, client, dependencies } =
        createPlacementStartupHarness(request);
      const transition = (phase: "connected" | "reconnecting") => {
        client.recoveryScopeReady = phase === "connected";
        Object.assign(gateway, { snapshot: { ...gateway.snapshot, phase } });
        for (const [listener] of vi.mocked(gateway.subscribe).mock.calls) {
          listener(gateway.snapshot);
        }
      };
      startup.start(input);
      try {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("sessions.send", expect.anything()),
        );
        if (timing !== "connected") {
          transition("reconnecting");
        }
        if (timing === "late-rejection") {
          transition("connected");
          await vi.waitFor(() =>
            expect(startup.get(input.recovery.sessionKey)?.error).toContain(
              "No matching user message",
            ),
          );
        }
        if (timing === "during-check") {
          transition("connected");
          await vi.waitFor(() =>
            expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
          );
        }
        if (timing === "storage-unavailable") {
          const storage = sessionStorage;
          vi.stubGlobal("sessionStorage", {
            getItem: storage.getItem.bind(storage),
            removeItem: storage.removeItem.bind(storage),
            setItem: () => {
              throw new DOMException("quota exceeded", "QuotaExceededError");
            },
          });
        }
        send.reject(new Error("gateway closed (1006): socket interrupted"));
        await flushStartupMicrotasks();
        history.resolve({ messages: [] });
        if (timing === "storage-unavailable") {
          expect(
            readSessionPlacementRecovery(
              input.recovery.gatewayUrl,
              input.recovery.recoveryScope,
              input.recovery.sessionKey,
            ),
          ).toBeNull();
          vi.unstubAllGlobals();
        }
        if (timing === "disconnect" || timing === "storage-unavailable") {
          transition("connected");
        }
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"),
        );
        for (let attempt = 0; attempt < 2; attempt += 1) {
          startup.retry(input.recovery.sessionKey);
          await vi.waitFor(() =>
            expect(startup.get(input.recovery.sessionKey)?.error).toContain(
              "No matching user message",
            ),
          );
          const status = startup.get(input.recovery.sessionKey);
          expect(status?.error).toContain("socket interrupted");
          expect(status?.error).toContain("No matching user message");
          expect(status?.initialTurn?.sendError).toBe(status?.error);
          expect(status?.action).toBe("check-delivery");
        }
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.dispatch"),
        ).toHaveLength(1);
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({
          messageId: input.recovery.messageId,
          message: input.recovery.message,
          sendError: "gateway closed (1006): socket interrupted",
          reason: "unconfirmed",
        });
        startup.dispose();
        const reloaded = createApplicationPlacementStartup(dependencies);
        try {
          reloaded.resumeRecovery();
          await vi.waitFor(() =>
            expect(reloaded.get(input.recovery.sessionKey)?.error).toContain("socket interrupted"),
          );
        } finally {
          reloaded.dispose();
        }
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["message", "credential"] as const)(
    "does not retain a late send diagnostic after %s ownership changes",
    async (change) => {
      const send = createDeferred<unknown>();
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 2) });
        }
        if (method === "sessions.send") {
          return send.promise;
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, gateway } = createPlacementStartupHarness(request);
      startup.start(input);
      try {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("sessions.send", expect.anything()),
        );
        if (change === "message") {
          writeSessionPlacementRecovery({ ...input.recovery, messageId: "replacement-message" });
        } else {
          Object.assign(gateway, { connectionRevision: 1 });
        }
        const before = readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        );
        send.reject(new Error("old owner's transport failure"));
        await flushStartupMicrotasks();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toEqual(before);
        expect(startup.get(input.recovery.sessionKey)).toBeNull();
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.dispatch",
          "sessions.send",
        ]);
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["rpc", "error", "timeout"] as const)(
    "delivery recovery rotates a cached %s rejection only on explicit Retry",
    async (failure) => {
      const rejection = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "send rejected",
      });
      const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 2) });
        }
        if (method === "sessions.reclaim") {
          return Promise.resolve({ ok: true });
        }
        if (method === "sessions.send") {
          if (payload?.idempotencyKey === "message-stable") {
            return failure === "rpc"
              ? Promise.reject(rejection)
              : Promise.resolve({ runId: "message-stable", status: failure });
          }
          return Promise.resolve({ runId: payload?.idempotencyKey, status: "started" });
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, chatSubmissions, client } = createPlacementStartupHarness(request);
      input.recovery = {
        ...input.recovery,
        target: { kind: "profile", profileId: "aws", machineClass: "fast" },
        attachments: [{ type: "file", mimeType: "text/plain", content: "SGk=" }],
      };
      writeSessionPlacementRecovery(input.recovery);
      startup.start(input);
      try {
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"),
        );
        expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).toBeNull();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({ phase: "paused", reason: "rejected", messageId: "message-stable" });
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        const replacement = readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        );
        expect(replacement?.messageId).not.toBe(input.recovery.messageId);
        await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)).toBeNull());
        const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
        expect(sends).toHaveLength(2);
        expect(sends[1]?.[1]).toMatchObject({
          key: input.recovery.sessionKey,
          message: input.recovery.message,
          attachments: input.recovery.attachments,
          idempotencyKey: expect.any(String),
        });
        expect(sends[1]?.[1]?.idempotencyKey).not.toBe("message-stable");
        expect(
          request.mock.calls
            .filter(([method]) => method === "sessions.dispatch")
            .map(([, payload]) => payload),
        ).toEqual(
          [1, 2].map(() => ({
            key: input.recovery.sessionKey,
            agentId: input.recovery.agentId,
            profileId: "aws",
            machineClass: "fast",
          })),
        );
        expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)?.pendingRunId).toBe(
          sends[1]?.[1]?.idempotencyKey,
        );
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["active", "local", "failed", "reclaimed"])(
    "delivery recovery checks uncertain sending without mutating %s placement",
    async (state) => {
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return Promise.resolve({ messages: [] });
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement(state, 2) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { startup, input, dependencies } = createPlacementStartupHarness(request);
      const attachments = [
        { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" },
      ];
      input.recovery = { ...input.recovery, phase: "sending", attachments };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)).toMatchObject({
            phase: "failed",
            action: "check-delivery",
            initialTurn: {
              text: input.recovery.message,
              sendState: "unconfirmed",
              attachments: [{ dataUrl: "data:text/plain;base64,SGk=" }],
            },
          }),
        );
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          expect.objectContaining({ sessionKey: input.recovery.sessionKey, limit: 1000 }),
        );
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({
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
            expect(reloaded.get(input.recovery.sessionKey)).toMatchObject({
              action: "check-delivery",
              initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
            }),
          );
          expect(request).toHaveBeenCalledTimes(2);
        } finally {
          reloaded.dispose();
        }
      } finally {
        startup.dispose();
      }
    },
  );

  it.each([
    "exact-user",
    "pending-queued",
    "pending-interrupted",
    "pending-cancelled",
    "retained-outside-page",
    "consumed",
    "assistant",
    "same-text",
    "unavailable",
  ])("delivery recovery settles only authoritative input custody (%s)", async (evidence) => {
    const acceptedInput =
      evidence.startsWith("pending-") ||
      evidence === "retained-outside-page" ||
      evidence === "consumed";
    const delivered = evidence === "exact-user" || acceptedInput;
    const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
      if (method === "chat.history") {
        if (evidence === "unavailable") {
          return Promise.reject(new Error("history unavailable"));
        }
        return Promise.resolve({
          sessionId: "physical-cloud-session",
          messages: acceptedInput
            ? []
            : [
                {
                  role: evidence === "assistant" ? "assistant" : "user",
                  content: [{ type: "text", text: "fix the cloud task" }],
                  __openclaw: {
                    idempotencyKey: evidence === "same-text" ? "other:user" : "message-stable:user",
                  },
                },
              ],
          pendingInputs: {
            items: evidence.startsWith("pending-")
              ? [
                  {
                    id: "accepted-initial-input",
                    runId: "message-stable",
                    state: evidence.slice("pending-".length),
                    acceptedAt: 1_000,
                    message: {
                      role: "user",
                      content: "fix the cloud task",
                      __openclaw: { id: "pending:accepted-initial-input" },
                    },
                  },
                ]
              : evidence === "retained-outside-page"
                ? Array.from({ length: 20 }, (_, index) => ({
                    id: `newer-${index}`,
                    runId: `newer-${index}`,
                    state: "interrupted",
                    acceptedAt: 1_001 + index,
                    message: { role: "user", content: `newer-${index}` },
                  }))
                : [],
            total:
              evidence === "retained-outside-page" ? 21 : evidence.startsWith("pending-") ? 1 : 0,
          },
          ...(acceptedInput &&
          Array.isArray(payload?.inputRunIds) &&
          payload.inputRunIds.includes("message-stable")
            ? {
                inputReceipts: [
                  evidence === "consumed"
                    ? {
                        runId: "message-stable",
                        state: "consumed",
                        consumedByEventId: "aggregate-user",
                      }
                    : { runId: "message-stable", state: "pending" },
                ],
              }
            : {}),
        });
      }
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
      }
      return Promise.resolve({ status: "started" });
    });
    const { startup, input, chatSubmissions, client } = createPlacementStartupHarness(request);
    input.recovery = { ...input.recovery, phase: "sending" };
    writeSessionPlacementRecovery(input.recovery);
    startup.resumeRecovery();
    try {
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
      );
      await vi.waitFor(() => {
        if (delivered) {
          expect(startup.get(input.recovery.sessionKey)).toBeNull();
          expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
          const handoff = chatSubmissions.readInitial(input.recovery.sessionKey, client);
          if (acceptedInput) {
            expect(handoff).toBeNull();
          } else {
            expect(handoff?.pendingRunId).toBe(input.recovery.messageId);
          }
        } else {
          expect(startup.get(input.recovery.sessionKey)).toMatchObject({
            phase: "failed",
            action: "check-delivery",
            initialTurn: { text: input.recovery.message },
          });
        }
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
      const stored = readSessionPlacementRecovery(
        input.recovery.gatewayUrl,
        input.recovery.recoveryScope,
        input.recovery.sessionKey,
      );
      if (delivered) {
        expect(stored).toBeNull();
      } else {
        expect(stored).toMatchObject({
          phase: "paused",
          reason: "unconfirmed",
          messageId: input.recovery.messageId,
        });
      }
    } finally {
      startup.dispose();
    }
  });

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
      const { startup, input, client, chatSubmissions } = createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
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
        expect(startup.get(input.recovery.sessionKey)).toBeNull();
        history.resolve({
          messages: [{ role: "user", __openclaw: { idempotencyKey: "message-stable:user" } }],
        });
        await flushStartupMicrotasks();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toEqual(retained);
        expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).toBeNull();
        expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
      } finally {
        startup.dispose();
      }
    },
  );
});
