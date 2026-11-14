import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { readStoredOutboxStore, storageTargetForComposer } from "../../lib/chat/outbox-store.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createDraftFixture, resetSubmissionMocks } from "./draft-submission-flow.test-support.ts";

afterEach(resetSubmissionMocks);

it("creates one guest dictation session and sends its first message into that session", async () => {
  const { flow, context, request } = createDraftFixture({
    scopes: ["operator.sessions.write"],
    request: async (method) =>
      method === "chat.send" ? { runId: "guest-first-turn", status: "started" } : undefined,
  });
  const create = vi.mocked(context.sessions.createResult);
  const pending = createDeferred<SessionCreateOutcome>();
  create.mockReturnValue(pending.promise);
  const first = flow.sessionStartup.prepareDictationSession();
  const repeated = flow.sessionStartup.prepareDictationSession();
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]?.[0]?.message).toBe("");
  pending.resolve({ key: "agent:main:guest-dictation", initialRun: { status: "idle" } });
  expect(await first).toBe("agent:main:guest-dictation");
  expect(await repeated).toBe("agent:main:guest-dictation");
  expect(flow.sessionStartup.dictationSessionKey()).toBe("agent:main:guest-dictation");
  flow.setMessage("Keep this dictated draft.");
  await flow.submit();
  expect(create).toHaveBeenCalledOnce();
  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([
    [
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:guest-dictation",
        message: "Keep this dictated draft.",
      }),
      expect.anything(),
    ],
  ]);
});

it("retains an empty prepared session after cancel and retires it with the draft", async () => {
  const { flow, context } = createDraftFixture({ scopes: ["operator.sessions.write"] });
  const create = vi.mocked(context.sessions.createResult);
  create.mockResolvedValue({ key: "agent:main:guest-dictation", initialRun: { status: "idle" } });
  await flow.sessionStartup.prepareDictationSession();
  await flow.sessionStartup.prepareDictationSession();
  expect(create).toHaveBeenCalledOnce();
  flow.invalidate();
  expect(flow.sessionStartup.dictationSessionKey()).toBeUndefined();
});

it("does not reuse a prepared session after its creation selection changes", async () => {
  const { flow, context } = createDraftFixture({ scopes: ["operator.sessions.write"] });
  const create = vi.mocked(context.sessions.createResult);
  create.mockResolvedValueOnce({ key: "agent:main:first-draft", initialRun: { status: "idle" } });
  create.mockResolvedValueOnce({ key: "agent:main:private-draft", initialRun: { status: "idle" } });
  expect(await flow.sessionStartup.prepareDictationSession()).toBe("agent:main:first-draft");
  flow.setVisibility("draft");
  expect(flow.sessionStartup.dictationSessionKey()).toBeUndefined();
  expect(await flow.sessionStartup.prepareDictationSession()).toBe("agent:main:private-draft");
  expect(create).toHaveBeenCalledTimes(2);
});

async function interruptPreparedSend(retryStatus: "started" | "timeout" | "error" = "started") {
  const interrupted = createDeferred<unknown>();
  let sends = 0;
  const { flow, context, request, gateway } = createDraftFixture({
    scopes: ["operator.sessions.write"],
    request: async (method) => {
      if (method !== "chat.send") {
        return undefined;
      }
      return ++sends === 1
        ? interrupted.promise
        : { runId: "retried-first-turn", status: retryStatus, stopReason: "restart" };
    },
  });
  const create = vi.mocked(context.sessions.createResult);
  create.mockResolvedValue({ key: "agent:main:prepared-retry", initialRun: { status: "idle" } });
  await flow.sessionStartup.prepareDictationSession();
  flow.setMessage("Retain the prepared target on retry.");
  const first = flow.submit();
  await vi.waitFor(() =>
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1),
  );
  flow.invalidate("gateway-changed");
  interrupted.reject(new Error("Connection lost before acknowledgment"));
  await first;
  return { flow, context, request, gateway, create };
}

it("retries an interrupted prepared-session send with the same target and idempotency key", async () => {
  const { flow, request, create } = await interruptPreparedSend();
  const resumed = flow.sessionStartup.resume();
  expect(resumed.kind).toBe("resume");
  if (resumed.kind !== "resume") {
    throw new Error("Expected the interrupted startup to resume");
  }
  await flow.submit(resumed);
  expect(create).toHaveBeenCalledOnce();
  const messages = request.mock.calls
    .filter(([method]) => method === "chat.send")
    .map(([, params]) => params);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    sessionKey: "agent:main:prepared-retry",
    message: "Retain the prepared target on retry.",
    idempotencyKey: expect.any(String),
  });
  expect(messages[1]).toEqual(messages[0]);
});

it.each(["reset", "selection", "client"] as const)(
  "retires an interrupted prepared target after a genuine %s change",
  async (change) => {
    const { flow, context, request, gateway, create } = await interruptPreparedSend();
    if (change === "reset") {
      flow.resetDraft();
    } else if (change === "selection") {
      flow.setVisibility("draft");
    } else {
      gateway.synchronize({
        ...context.gateway,
        snapshot: {
          ...context.gateway.snapshot,
          client: createTestGatewayClient(async () => undefined),
        },
      });
    }
    expect(flow.sessionStartup.resume()).toEqual({
      kind: change === "reset" ? "wait" : "owner-changed",
    });
    expect(flow.sessionStartup.dictationSessionKey()).toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);

it.each(["timeout", "error"] as const)(
  "retains the dictated turn for recovery when interrupted first-send retry returns %s",
  async (status) => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { flow, context, create } = await interruptPreparedSend(status);
    const resumed = flow.sessionStartup.resume();
    expect(resumed.kind).toBe("resume");
    if (resumed.kind !== "resume") {
      throw new Error("Expected the interrupted startup to resume");
    }
    await flow.submit(resumed);
    expect(create).toHaveBeenCalledOnce();
    const target = storageTargetForComposer({
      settings: context.gateway.connection,
      client: context.gateway.snapshot.client,
    });
    const stored = readStoredOutboxStore(sessionStorage, target);
    expect(Object.values(stored.sessions).flatMap((session) => session.queue ?? [])).toEqual([
      expect.objectContaining({
        text: "Retain the prepared target on retry.",
        sendState: "failed",
        sendError: expect.any(String),
        sessionKey: "agent:main:prepared-retry",
        sendAttempts: 1,
      }),
    ]);
    expect(flow.message).toBe("");
    expect(context.navigateAndWait).toHaveBeenCalled();
  },
);
