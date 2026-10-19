/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { GatewayProtocolRequestOptions } from "../../../../packages/gateway-client/src/protocol-client.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  deleteSessionPlacementDraft,
  startSessionPlacementInitialTurn,
} from "./session-placement-startup.ts";

const params = {
  key: "agent:cloud:test",
  agentId: "cloud",
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

function placement(state: string, environmentId = "environment-1") {
  return { placement: { state, environmentId } };
}

function fakeTimers() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
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
      fakeTimers();
      const abort = new AbortController();
      const frames: string[] = [];
      let ready = false;
      let writes = 0;
      const pending = new GatewayPendingRequests({
        createRequestId: () => "placement-initial-turn",
        nowMs: Date.now,
        requestTimeoutMs: 30_000,
      });
      onTestFinished(() => pending.flush(new Error("test disposed")));
      const request = vi.fn(
        (method: string, input?: unknown, options?: GatewayProtocolRequestOptions) => {
          if (method !== "sessions.send") {
            return Promise.resolve(method === "sessions.dispatch" ? placement("active") : {});
          }
          return pending.request(
            {
              send(raw) {
                frames.push(raw);
                const frame = JSON.parse(raw) as { id: string };
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
                      details: { reason: "startup-sidecars", method },
                    },
                  });
                }
              },
            },
            method,
            input,
            options,
          );
        },
      );
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
      await vi.advanceTimersByTimeAsync(500);
      expect(await outcome).toMatchObject({ status: cancel ? "cancelled" : "started" });
      expect(writes).toBe(cancel ? 0 : 1);
      expect(new Set(frames).size).toBe(1);
      expect(pending.hasPending).toBe(false);
    },
  );

  it.each([false, true])(
    "settles a dispatched send before cancellation cleanup (cleanup=%s)",
    async (cleanup) => {
      fakeTimers();
      const abort = new AbortController();
      const dispatched = Promise.withResolvers<RequestFrame>();
      const frames: RequestFrame[] = [];
      const pending = new GatewayPendingRequests({
        createRequestId: () => "placement-late-ack",
        nowMs: Date.now,
      });
      onTestFinished(() => pending.flush(new Error("test disposed")));
      const request = vi.fn(
        (method: string, input?: unknown, options?: GatewayProtocolRequestOptions) => {
          if (method !== "sessions.send") {
            return Promise.resolve(method === "sessions.dispatch" ? placement("active") : {});
          }
          return pending.request(
            {
              send(raw) {
                const frame = JSON.parse(raw) as RequestFrame;
                frames.push(frame);
                dispatched.resolve(frame);
              },
            },
            method,
            input,
            options,
          );
        },
      );
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
    {
      name: "profile",
      target: {
        kind: "profile",
        profileId: "aws",
        os: "windows/wsl2",
        machineClass: "fast",
      } as const,
      expectedTarget: { profileId: "aws", os: "windows/wsl2", machineClass: "fast" },
    },
    {
      name: "device",
      target: { kind: "device", deviceId: "device-1" } as const,
      expectedTarget: { deviceId: "device-1" },
    },
    {
      name: "automatic device",
      target: { kind: "auto-device" } as const,
      expectedTarget: { autoDevice: true },
    },
  ])("serializes a $name target to the flat dispatch contract", async (testCase) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "worker" } })
      .mockResolvedValueOnce({ runId: "run-target" });

    await expect(
      startSessionPlacementInitialTurn(
        clientWith(request),
        { ...params, target: testCase.target },
        () => true,
      ),
    ).resolves.toMatchObject({ status: "started" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.dispatch", {
      key: params.key,
      agentId: params.agentId,
      ...testCase.expectedTarget,
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

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "unknown cloud profile",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());
  });

  it("reclaims an allocated worker when provisioning becomes failed", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-failed" },
      })
      .mockResolvedValueOnce({
        session: { placement: { state: "failed", environmentId: "environment-failed" } },
      })
      .mockResolvedValueOnce({ ok: true });

    const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({
      status: "dispatch-rejected",
      error: "session placement became failed",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("keeps recovery state when failed-placement cleanup is rejected", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "failed", environmentId: "environment-failed" },
      })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
  });

  it("sends after an ambiguous dispatch error when durable placement is active", async () => {
    const attachments = [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }];
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ session: { placement: { state: "active" } } })
      .mockResolvedValueOnce({ runId: "run-1", messageSeq: 3 });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), { ...params, attachments }, () => true),
    ).resolves.toMatchObject({
      status: "started",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.describe", { key: params.key });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.send",
      expect.objectContaining({ message: params.message, attachments }),
      expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS }),
    );
  });

  it.each([{ name: "absent placement", response: { session: {} } }])(
    "waits through $name after an ambiguous dispatch error",
    async ({ response }) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const request = vi.fn().mockRejectedValueOnce(new Error("transport closed"));
      request.mockResolvedValueOnce(response);
      request
        .mockResolvedValueOnce({
          session: { placement: { state: "active", environmentId: "environment-1" } },
        })
        .mockResolvedValueOnce({ runId: "run-1" });

      const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toMatchObject({ status: "started" });
      expect(request).toHaveBeenNthCalledWith(3, "sessions.describe", { key: params.key });
      expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
      expect(request).toHaveBeenNthCalledWith(
        4,
        "sessions.send",
        expect.objectContaining({ message: params.message }),
        expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS }),
      );
    },
  );

  it.each(["gateway-restarting"])(
    "continues provisioning automatically after %s without reclaiming the worker",
    async (reason) => {
      vi.useFakeTimers();
      try {
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
                details: { reason },
              });
            }
            return { session: { placement: { state: "active" } } };
          }
          return { status: "started" };
        });
        const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
        await vi.runAllTimersAsync();
        await expect(outcome).resolves.toMatchObject({ status: "started" });
        expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          placement: { state: "provisioning", environmentId: "environment-unavailable" },
        })
        .mockRejectedValueOnce(new Error("lookup unavailable 1"))
        .mockRejectedValueOnce(new Error("lookup unavailable 2"))
        .mockRejectedValueOnce(new Error("lookup unavailable 3"))
        .mockRejectedValueOnce(new Error("lookup unavailable 4"));
      if (cleanupError) {
        request.mockRejectedValueOnce(new Error(cleanupError));
      } else {
        request.mockResolvedValueOnce({ worker: { state: "destroyed" } });
      }

      const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => true);
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toEqual({ status: "cleanup-rejected", error: expectedError });
      expect(request).toHaveBeenCalledTimes(6);
      expect(request).toHaveBeenNthCalledWith(6, "sessions.reclaim", {
        key: params.key,
        agentId: params.agentId,
      });
      expect(request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["pending", "pending then unavailable"] as const)(
    "explains an unfinished placement without discarding it when the Gateway is %s",
    async (observation) => {
      vi.useFakeTimers();
      try {
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

        const outcome = startSessionPlacementInitialTurn(
          clientWith(request),
          { ...params, mode: "recover" },
          () => true,
        );
        await vi.runAllTimersAsync();
        await expect(outcome).resolves.toEqual({
          status: "cleanup-rejected",
          error:
            observation === "pending"
              ? "Worker setup is still in progress. Retry to check the existing worker; your message has not been sent."
              : "Could not confirm whether worker setup finished. Retry to check again; your message has not been sent.",
        });
        expect(request).not.toHaveBeenCalledWith("sessions.reclaim", expect.anything());
        expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
        expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a cancelled placement recoverable when reclaim fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-1" } })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => false),
    ).resolves.toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it("reclaims by session when cancellation coincides with a lookup failure", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async () => {
        current = false;
        throw new Error("reconnecting");
      })
      .mockResolvedValueOnce({ ok: true });

    const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => current);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("reclaims without carrying an environment identity", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "provisioning", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async () => {
        current = false;
        return { session: { placement: { state: "provisioning" } } };
      })
      .mockResolvedValueOnce({ ok: true });

    const outcome = startSessionPlacementInitialTurn(clientWith(request), params, () => current);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("keeps the accepted message identity when post-send cleanup fails", async () => {
    let current = true;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockImplementationOnce(async (_method, requestParams) => {
        current = false;
        return { runId: "run-1", requestParams };
      })
      .mockRejectedValueOnce(new Error("cleanup unavailable"));

    const outcome = await startSessionPlacementInitialTurn(
      clientWith(request),
      params,
      () => current,
    );
    const sent = request.mock.calls[1]?.[1] as { idempotencyKey: string };
    expect(outcome).toEqual({
      status: "cleanup-rejected",
      error: "cleanup unavailable",
      messageId: sent.idempotencyKey,
    });
  });

  it("reclaims the worker after a definitive first-turn rejection", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "message rejected",
          retryable: false,
        }),
      )
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(clientWith(request), params, () => true),
    ).resolves.toEqual({
      status: "send-definitive-rejected",
      error: "message rejected",
      messageId: expect.any(String),
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
  });

  it("reclaims the worker without sending when recovery cannot enter the sending phase", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      startSessionPlacementInitialTurn(
        clientWith(request),
        { ...params, messageId: "message-retained" },
        () => true,
        () => false,
      ),
    ).resolves.toEqual({
      status: "send-not-started",
      messageId: "message-retained",
      error: "placement recovery storage is unavailable",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.reclaim", {
      key: params.key,
      agentId: params.agentId,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
  });

  it.each([
    { error: new Error("gateway not connected"), status: "send-not-started", cleanupFails: true },
  ])(
    "preserves $status classification when cleanup fails=$cleanupFails",
    async ({ error, status, cleanupFails }) => {
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: { state: "active" } });
        }
        if (method === "sessions.send") {
          return Promise.reject(error);
        }
        if (method === "sessions.reclaim") {
          return cleanupFails
            ? Promise.reject(new Error("cleanup unavailable"))
            : Promise.resolve({ ok: true });
        }
        throw new Error(`unexpected method ${method}`);
      });
      await expect(
        startSessionPlacementInitialTurn(
          clientWith(request),
          { ...params, messageId: "retained" },
          () => true,
        ),
      ).resolves.toEqual({
        status,
        messageId: "retained",
        error: error.message + (cleanupFails ? "; cleanup failed: cleanup unavailable" : ""),
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "sessions.dispatch",
        "sessions.send",
        "sessions.reclaim",
      ]);
    },
  );

  it.each([
    {
      name: "delete no-op",
      deleteResult: { ok: true, deleted: false },
      expectedError: "placement draft session was not deleted",
    },
  ])("unarchives a local draft after $name", async ({ deleteResult, expectedError }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-draft" } };
      }
      if (method === "sessions.delete") {
        return deleteResult;
      }
      return { ok: true };
    });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBe(expectedError);
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      key: params.key,
      agentId: params.agentId,
      archived: false,
      expectedSessionId: "session-draft",
    });
  });

  it("reports both delete and restore failures during local draft cleanup", async () => {
    let patchCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-draft" } };
      }
      if (method === "sessions.delete") {
        throw new Error("delete unavailable");
      }
      patchCalls += 1;
      if (patchCalls === 2) {
        throw new Error("restore unavailable");
      }
      return { ok: true };
    });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId),
    ).resolves.toBe(
      "delete unavailable; restoring the placement draft failed: restore unavailable",
    );
  });

  it("reclaims a recovered worker before archiving and deleting its draft session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        session: {
          sessionId: "session-recovered",
          placement: { state: "active", environmentId: "environment-recovered" },
        },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId, true),
    ).resolves.toBeUndefined();
    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: params.key }],
      ["sessions.reclaim", { key: params.key, agentId: params.agentId }],
      [
        "sessions.patch",
        {
          key: params.key,
          agentId: params.agentId,
          archived: true,
          expectedSessionId: "session-recovered",
        },
      ],
      [
        "sessions.delete",
        {
          key: params.key,
          agentId: params.agentId,
          deleteTranscript: true,
          expectedSessionId: "session-recovered",
          archivedOnly: true,
        },
      ],
    ]);
  });

  it("retains a recovered draft when worker placement cannot be verified", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId, true),
    ).resolves.toBe("session placement could not be verified");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.describe", { key: params.key });
  });

  it("treats a missing recovered session as already cleaned up", async () => {
    const request = vi.fn().mockResolvedValueOnce({ session: null });

    await expect(
      deleteSessionPlacementDraft(clientWith(request), params.key, params.agentId, true),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns the same idempotency key when first-turn sending fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        placement: { state: "active", environmentId: "environment-1" },
      })
      .mockRejectedValueOnce(new Error("transport closed"));

    const outcome = await startSessionPlacementInitialTurn(clientWith(request), params, () => true);
    expect(outcome).toMatchObject({ status: "send-rejected", error: "transport closed" });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.send",
      expect.objectContaining({
        key: params.key,
        message: params.message,
        idempotencyKey: (outcome as { messageId: string }).messageId,
      }),
      expect.objectContaining({ timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS }),
    );
  });
});
