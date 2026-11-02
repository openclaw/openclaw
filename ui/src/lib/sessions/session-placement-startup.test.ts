/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { GatewayProtocolRequestOptions } from "../../../../packages/gateway-client/src/protocol-client.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { useFakeClock as fakeTimers } from "../../test-helpers/fake-clock.ts";
import { sessionRequest as gatewayRequest } from "./hydration-family.test-support.ts";
import {
  deleteSessionPlacementDraft,
  startSessionPlacementInitialTurn,
} from "./session-placement-startup.ts";

const targetKey = { key: "agent:cloud:test", agentId: "cloud" };
const params = {
  ...targetKey,
  sessionId: "physical-startup-session",
  target: { kind: "profile", profileId: "aws" } as const,
  message: "run remotely",
  mode: "dispatch" as const,
};

function clientWith(
  request: ReturnType<typeof vi.fn>,
): Parameters<typeof startSessionPlacementInitialTurn>[0] {
  const client = { request: request as GatewayBrowserClient["request"] };
  return {
    client,
    describe: (target) => client.request("sessions.describe", target),
  };
}

function start(
  request: ReturnType<typeof vi.fn>,
  overrides: Partial<Parameters<typeof startSessionPlacementInitialTurn>[1]> = {},
  current = () => true,
  beforeSend?: () => boolean,
) {
  return startSessionPlacementInitialTurn(
    clientWith(request),
    { ...params, ...overrides },
    current,
    beforeSend,
  );
}

function replies(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    if (value instanceof Error) {
      request.mockRejectedValueOnce(value);
    } else {
      request.mockResolvedValueOnce(value);
    }
  }
  return request;
}

function deleteDraft(request: ReturnType<typeof vi.fn>, recovered = false) {
  return deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId, recovered);
}

function placement(state: string, environmentId = "environment-1") {
  return { placement: { state, environmentId } };
}

function expectReclaim(request: ReturnType<typeof vi.fn>, call: number) {
  expect(request).toHaveBeenNthCalledWith(call, "sessions.reclaim", targetKey);
}

function expectNotSent(request: ReturnType<typeof vi.fn>) {
  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
}

function pendingSend(
  onSend: (frame: RequestFrame) => void,
  pendingOptions: Omit<ConstructorParameters<typeof GatewayPendingRequests>[0], "nowMs"> = {
    createRequestId: () => "placement-initial-turn",
    requestTimeoutMs: 30_000,
  },
) {
  fakeTimers();
  const frames: string[] = [];
  const pending = new GatewayPendingRequests({
    ...pendingOptions,
    nowMs: Date.now,
  });
  onTestFinished(() => pending.flush(new Error("test disposed")));
  const request = vi.fn(
    (method: string, input?: unknown, options?: GatewayProtocolRequestOptions) => {
      if (method !== "chat.send") {
        return Promise.resolve(method === "sessions.dispatch" ? placement("active") : {});
      }
      return pending.request(
        {
          send(raw) {
            const frame = JSON.parse(raw) as RequestFrame;
            frames.push(raw);
            onSend(frame);
          },
        },
        method,
        input,
        options,
      );
    },
  );
  return { frames, pending, request };
}

describe("session placement startup", () => {
  it.each([
    { waitMs: 45_000, cancel: false },
    { waitMs: 240_000, cancel: false },
    { waitMs: 45_000, cancel: true },
    { waitMs: 240_000, cancel: true },
  ])(
    "retains a cancellable initial send through startup ($waitMs ms, cancel=$cancel)",
    async ({ waitMs, cancel }) => {
      const abort = new AbortController();
      let ready = false;
      let writes = 0;
      const { frames, pending, request } = pendingSend((frame) => {
        if (ready) {
          writes += 1;
          pending.handleResponse({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: "initial-turn", status: "started" },
          });
        } else {
          pending.handleResponse({
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Agent is preparing",
              retryable: true,
              retryAfterMs: 500,
              details: { reason: "startup-sidecars", method: "chat.send" },
            },
          });
        }
      });
      const outcome = start(request, { signal: abort.signal }, () => !abort.signal.aborted);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pending.hasPending).toBe(true);
      expect(writes).toBe(0);
      if (cancel) {
        abort.abort();
        expect(pending.hasPending).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(waitMs - 30_000);
      ready = true;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await outcome).toMatchObject({ status: cancel ? "cancelled" : "started" });
      expect(writes).toBe(cancel ? 0 : 1);
      expect(new Set(frames).size).toBe(1);
      expect(pending.hasPending).toBe(false);
    },
  );

  it.each([false, true])(
    "settles a dispatched send before cancellation cleanup (cleanup=%s)",
    async (cleanup) => {
      const abort = new AbortController();
      const dispatched = Promise.withResolvers<RequestFrame>();
      const { frames, pending, request } = pendingSend((frame) => dispatched.resolve(frame), {
        createRequestId: () => "placement-late-ack",
      });
      const outcome = start(
        request,
        {
          messageId: "retained-message",
          signal: abort.signal,
          cleanupOnCancellation: () => cleanup,
        },
        () => !abort.signal.aborted,
      );
      let settled = false;
      void outcome.then(() => (settled = true));
      const frame = await dispatched.promise;
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());

      pending.handleResponse({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { status: "started", runId: "accepted-after-cancellation" },
      });
      await expect(outcome).resolves.toEqual({ status: cleanup ? "cancelled" : "interrupted" });
      expect(request.mock.calls.filter(([method]) => method === "sessions.reclaim")).toHaveLength(
        cleanup ? 1 : 0,
      );
      await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
      expect(frames).toHaveLength(1);
      expect(pending.hasPending).toBe(false);
    },
  );

  it.each([
    [
      { kind: "profile", profileId: "aws", os: "windows/wsl2", machineClass: "fast" },
      { profileId: "aws", os: "windows/wsl2", machineClass: "fast" },
    ],
    [{ kind: "device", deviceId: "device-1" }, { deviceId: "device-1" }],
    [{ kind: "auto-device" }, { autoDevice: true }],
  ] as const)("serializes %j to the flat dispatch contract", async (target, expectedTarget) => {
    const request = replies(placement("active", "worker"), { runId: "run-target" });

    await expect(start(request, { target })).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.dispatch", {
      ...targetKey,
      ...expectedTarget,
    });
  });

  it("does not reconcile a definitive dispatch rejection", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown cloud profile",
        retryable: false,
      }),
    );

    await expect(start(request)).resolves.toEqual({
      status: "dispatch-rejected",
      error: "unknown cloud profile",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());
  });

  it("reclaims an allocated worker when provisioning becomes failed", async () => {
    fakeTimers();
    const request = replies(
      placement("provisioning", "environment-failed"),
      { session: placement("failed", "environment-failed") },
      { ok: true },
    );

    const outcome = start(request);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({
      status: "dispatch-rejected",
      error: "session placement became failed",
    });
    expectReclaim(request, 3);
    expectNotSent(request);
  });

  it("keeps recovery state when failed-placement cleanup is rejected", async () => {
    const request = replies(
      placement("failed", "environment-failed"),
      new Error("cleanup unavailable"),
    );

    await expect(start(request)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
  });

  it("waits through absent placement after an ambiguous dispatch error", async () => {
    const attachments = [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }];
    fakeTimers();
    const request = replies(new Error("transport closed"));
    request.mockResolvedValueOnce({ session: {} });
    request
      .mockResolvedValueOnce({ session: placement("active", "environment-1") })
      .mockResolvedValueOnce({ runId: "run-1" });

    const outcome = start(request, { attachments });
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.describe", { key: params.key });
    expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
    expect(request).toHaveBeenNthCalledWith(
      4,
      "chat.send",
      expect.objectContaining({ message: params.message, attachments }),
      expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS }),
    );
  });

  it("continues provisioning after a Gateway restart without reclaiming the worker", async () => {
    fakeTimers();
    let unavailableReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.dispatch") {
        return { placement: { state: "provisioning" } };
      }
      if (method === "sessions.describe") {
        if (unavailableReads++ < 8) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Gateway temporarily unavailable",
            retryable: true,
            details: { reason: "gateway-restarting" },
          });
        }
        return { session: { placement: { state: "active" } } };
      }
      return { status: "started" };
    });
    const outcome = start(request);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toMatchObject({ status: "started" });
    expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it.each([
    {
      name: "reclaims the session placement",
      cleanupError: undefined,
      expectedError: "session placement could not be verified",
    },
    {
      name: "reports a rejected worker cleanup",
      cleanupError: "cleanup unavailable",
      expectedError: "session placement could not be verified; cleanup failed: cleanup unavailable",
    },
  ])("$name when placement lookups remain unavailable", async ({ cleanupError, expectedError }) => {
    fakeTimers();
    const request = replies(
      placement("provisioning", "environment-unavailable"),
      new Error("lookup unavailable 1"),
      new Error("lookup unavailable 2"),
      new Error("lookup unavailable 3"),
      new Error("lookup unavailable 4"),
    );
    if (cleanupError) {
      request.mockRejectedValueOnce(new Error(cleanupError));
    } else {
      request.mockResolvedValueOnce({ worker: { state: "destroyed" } });
    }

    const outcome = start(request);
    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toEqual({ status: "cleanup-rejected", error: expectedError });
    expect(request).toHaveBeenCalledTimes(6);
    expectReclaim(request, 6);
    expect(request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
  });

  it.each(["pending", "pending then unavailable"] as const)(
    "explains an unfinished placement without discarding it when the Gateway is %s",
    async (observation) => {
      fakeTimers();
      const pending = { state: "provisioning", environmentId: "environment-slow" };
      const request = vi.fn();
      if (observation === "pending") {
        request.mockResolvedValue({ session: { placement: pending } });
      } else {
        request.mockRejectedValue(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "gateway restarting",
            retryable: true,
            details: { reason: "gateway-restarting" },
          }),
        );
      }
      request.mockResolvedValueOnce({ session: { placement: pending } });

      const outcome = start(request, { mode: "recover" });
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toEqual({
        status: "cleanup-rejected",
        error:
          observation === "pending"
            ? "Worker setup is still in progress. Retry to check the existing worker; your message has not been sent."
            : "Could not confirm whether worker setup finished. Retry to check again; your message has not been sent.",
      });
      expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
      expectNotSent(request);
      expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    },
  );

  it("keeps a cancelled placement recoverable when reclaim fails", async () => {
    const request = replies(placement("active"), new Error("cleanup unavailable"));

    await expect(start(request, {}, () => false)).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
    expectReclaim(request, 2);
    expectNotSent(request);
  });

  it.each(["lookup failure", "missing environment"] as const)(
    "reclaims by session when cancellation coincides with %s",
    async (observation) => {
      fakeTimers();
      let current = true;
      const request = replies(placement("provisioning"))
        .mockImplementationOnce(async () => {
          current = false;
          if (observation === "lookup failure") {
            throw new Error("reconnecting");
          }
          return { session: { placement: { state: "provisioning" } } };
        })
        .mockResolvedValueOnce({ ok: true });
      const outcome = start(request, {}, () => current);
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toEqual({ status: "cancelled" });
      expectReclaim(request, 3);
    },
  );

  it("keeps the accepted message identity when post-send cleanup fails", async () => {
    let current = true;
    const request = replies(placement("active"))
      .mockImplementationOnce(async (_method, requestParams) => {
        current = false;
        return { runId: "run-1", requestParams };
      })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    const outcome = await start(request, {}, () => current);
    const sent = request.mock.calls[1]?.[1] as { idempotencyKey: string };
    expect(outcome).toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
      messageId: sent.idempotencyKey,
    });
  });

  it.each([false, true])(
    "reclaims only the same worker after a first-turn rejection (replaced=%s)",
    async (replaced) => {
      const request = replies(
        placement("active"),
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "message rejected",
          retryable: false,
          ...(replaced ? { details: { reason: "active-leaf-changed" } } : {}),
        }),
        { ok: true },
      );

      await expect(start(request)).resolves.toEqual({
        status: "send-definitive-rejected",
        error: "message rejected",
        messageId: expect.any(String),
      });
      if (replaced) {
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.dispatch",
          "chat.send",
        ]);
      } else {
        expectReclaim(request, 3);
      }
    },
  );

  it("reclaims the worker without sending when recovery cannot enter the sending phase", async () => {
    const request = replies(placement("active"), { ok: true });

    await expect(
      start(request, { messageId: "message-retained" }, undefined, () => false),
    ).resolves.toEqual({
      status: "send-not-started",
      messageId: "message-retained",
      error: "placement recovery storage is unavailable",
    });
    expectReclaim(request, 2);
    expectNotSent(request);
  });

  it("preserves send-not-started classification when cleanup fails", async () => {
    const request = gatewayRequest({
      "sessions.dispatch": () => placement("active"),
      "chat.send": () => {
        throw new Error("gateway not connected");
      },
      "sessions.reclaim": () => {
        throw new Error("cleanup unavailable");
      },
    });
    await expect(start(request, { messageId: "retained" })).resolves.toEqual({
      status: "send-not-started",
      messageId: "retained",
      error: "gateway not connected; cleanup failed: cleanup unavailable",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.dispatch",
      "chat.send",
      "sessions.reclaim",
    ]);
  });

  it.each([false, true])(
    "reports local draft cleanup failure (restore rejected: %s)",
    async (restoreFails) => {
      const request = replies(
        { session: { sessionId: "session-draft" } },
        { ok: true },
        restoreFails ? new Error("delete unavailable") : { ok: true, deleted: false },
        restoreFails ? new Error("restore unavailable") : { ok: true },
      );
      await expect(deleteDraft(request)).resolves.toBe(
        restoreFails
          ? "delete unavailable; restoring the placement draft failed: restore unavailable"
          : "placement draft session was not deleted",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "sessions.describe",
        "sessions.patch",
        "sessions.delete",
        "sessions.patch",
      ]);
      if (!restoreFails) {
        expect(request).toHaveBeenLastCalledWith("sessions.patch", {
          ...targetKey,
          archived: false,
          expectedSessionId: "session-draft",
        });
      }
    },
  );

  it("reclaims a recovered worker before archiving and deleting its draft session", async () => {
    const request = replies(
      {
        session: {
          sessionId: "session-recovered",
          placement: { state: "active", environmentId: "environment-recovered" },
        },
      },
      { ok: true },
      { ok: true },
      { ok: true, deleted: true },
    );

    await expect(deleteDraft(request, true)).resolves.toBeUndefined();
    const draftTarget = { ...targetKey, expectedSessionId: "session-recovered" };
    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: params.key }],
      ["sessions.reclaim", { key: params.key, agentId: params.agentId }],
      ["sessions.patch", { ...draftTarget, archived: true }],
      ["sessions.delete", { ...draftTarget, deleteTranscript: true, archivedOnly: true }],
    ]);
  });

  it("retains a recovered draft when worker placement cannot be verified", async () => {
    const request = replies(new Error("gateway unavailable"));

    await expect(deleteDraft(request, true)).resolves.toBe(
      "session placement could not be verified",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.describe", { key: params.key });
  });

  it("treats a missing recovered session as already cleaned up", async () => {
    const request = replies({ session: null });

    await expect(deleteDraft(request, true)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns the same idempotency key when first-turn sending fails", async () => {
    const request = replies(placement("active"), new Error("transport closed"));

    const outcome = await start(request);
    expect(outcome).toMatchObject({ status: "send-rejected", error: "transport closed" });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "chat.send",
      expect.objectContaining({
        sessionKey: params.key,
        message: params.message,
        idempotencyKey: (outcome as { messageId: string }).messageId,
      }),
      expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS }),
    );
  });
});
