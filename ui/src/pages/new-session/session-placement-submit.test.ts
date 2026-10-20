import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  clearSessionPlacementRecovery,
  readSessionPlacementRecovery,
  type SessionPlacementPendingRecovery as SessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import { advanceSessionPlacementDraft as advanceSessionPlacementDraftWithRecovery } from "../../lib/sessions/session-placement-submit.ts";

type AdvanceOptions = Partial<
  Omit<
    Parameters<typeof advanceSessionPlacementDraftWithRecovery>[0],
    "client" | "recovery" | "describe"
  >
>;

const gatewayUrl = "ws://gateway.example";
const recoveryScope = "principal-a";
function recoveryRecord(
  sessionKey: string,
  message: string,
  overrides: Partial<SessionPlacementRecovery> = {},
): SessionPlacementRecovery {
  return {
    sessionKey,
    message,
    messageId: `message-${sessionKey.split(":").at(-1)}`,
    target: { kind: "profile", profileId: "aws" },
    agentId: "cloud",
    gatewayUrl,
    recoveryScope,
    phase: "dispatching",
    ...overrides,
  };
}
function storeRecovery(record: SessionPlacementRecovery) {
  sessionStorage.setItem(recoveryStorageKey(record.sessionKey), JSON.stringify(record));
}

function advanceSessionPlacementDraft(
  request: ReturnType<typeof vi.fn>,
  recovery: SessionPlacementRecovery,
  options: AdvanceOptions = {},
) {
  const client = clientWith(request);
  return advanceSessionPlacementDraftWithRecovery({
    client,
    recovery,
    describe: (params) => client.request("sessions.describe", params),
    mode: "dispatch",
    isLifecycleCurrent: () => true,
    ownsRecovery: () => true,
    clearRecovery: vi.fn(),
    setRecoveryPhase: vi.fn(),
    cleanupOnCancellation: () => true,
    ...options,
  });
}

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

const recoveryStorageKey = (sessionKey: string) =>
  sessionPlacementRecoveryExactStorageKey("ws://gateway.example", "principal-a", sessionKey);

describe("session placement draft advancement", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves a recovered session when recovery storage becomes unavailable", async () => {
    storeRecovery(recoveryRecord("agent:cloud:recovered", "resume remotely", { phase: "sending" }));
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
    });
    const request = vi.fn().mockRejectedValue(new Error("history unavailable"));
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft(
        request,
        recoveryRecord("agent:cloud:recovered", "resume remotely", { phase: "sending" }),
        { mode: "recover", clearRecovery },
      ),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "unconfirmed",
        message: "resume remotely",
        error: expect.stringContaining("Keep this page open"),
      },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("normalizes recovered mentions without replacing a newer durable session", async () => {
    const sessionKey = "agent:cloud:older";
    const storedMention = { profileId: "profile-alex", start: 0, end: 5, displayName: "Alex" };
    storeRecovery(recoveryRecord(sessionKey, "@Alex older task", { mentions: [storedMention] }));
    const recovered = readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey);
    if (!recovered) {
      throw new Error("Expected the older startup to remain recoverable");
    }
    const newerRecovery = recoveryRecord("agent:cloud:newer", "@Alex newer task", {
      mentions: [storedMention],
    });
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        expect(writeSessionPlacementRecovery(newerRecovery)).toBe(true);
        return Promise.resolve({ placement: { state: "active", environmentId: "worker-older" } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ runId: "run-older", status: "started" });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const setRecoveryPhase = vi.fn();
    const clearRecovery = vi.fn(() =>
      clearSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey),
    );

    await expect(
      advanceSessionPlacementDraft(
        request,
        recoveryRecord(sessionKey, recovered.message, {
          mentions: recovered.mentions,
          messageId: "message-older",
        }),
        { clearRecovery, setRecoveryPhase },
      ),
    ).resolves.toMatchObject({ status: "started", messageId: "message-older" });
    expect(setRecoveryPhase).toHaveBeenCalledWith("sending", true);
    expect(
      readSessionPlacementRecovery(gatewayUrl, recoveryScope, newerRecovery.sessionKey),
    ).toEqual({
      ...newerRecovery,
      mentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
    });
    expect(
      JSON.parse(sessionStorage.getItem(recoveryStorageKey(newerRecovery.sessionKey)) ?? "null")
        .mentions,
    ).toEqual([{ profileId: "profile-alex", start: 0, end: 5 }]);
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      "sessions.send",
      {
        key: sessionKey,
        agentId: "cloud",
        message: "@Alex older task",
        mentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
        attachments: undefined,
        idempotencyKey: "message-older",
      },
      expect.anything(),
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(0);
    expect(clearRecovery).toHaveBeenCalledWith("resolved");
  });

  it("fails closed when the current durable owner cannot persist sending", async () => {
    const storage = sessionStorage;
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        vi.stubGlobal("sessionStorage", {
          getItem: storage.getItem.bind(storage),
          removeItem: storage.removeItem.bind(storage),
          setItem: vi.fn(() => {
            throw new DOMException("storage disabled", "SecurityError");
          }),
        });
        return Promise.resolve({ placement: { state: "active", environmentId: "worker-current" } });
      }
      if (method === "sessions.reclaim") {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const setRecoveryPhase = vi.fn();

    await expect(
      advanceSessionPlacementDraft(request, recoveryRecord("agent:cloud:current", "current task"), {
        setRecoveryPhase,
      }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "not-sent",
        message: "current task",
        error:
          "Recovery could not be saved in this tab. Keep this page open.\nplacement recovery storage is unavailable",
      },
    });
    expect(setRecoveryPhase).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("sessions.reclaim", {
      key: "agent:cloud:current",
      agentId: "cloud",
    });
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
  });

  it.each([
    {
      name: "the page is interrupted after accepted delivery",
      lifecycleCurrent: false,
      recoveryOwned: true,
      status: "interrupted",
      retirement: "interrupted",
    },
    {
      name: "a newer owner takes over",
      lifecycleCurrent: true,
      recoveryOwned: false,
      status: "ownership-lost",
      retirement: "resolved",
    },
  ] as const)("retires only the completed submission when $name", async (testCase) => {
    const { lifecycleCurrent, recoveryOwned, retirement, status } = testCase;
    const sessionKey = "agent:cloud:stale";
    const newerRecovery = recoveryRecord("agent:cloud:newer", "newer task");
    const request = vi
      .fn()
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-1" } })
      .mockImplementationOnce(async () => {
        if (!recoveryOwned) {
          expect(writeSessionPlacementRecovery(newerRecovery)).toBe(true);
        }
        return { runId: "run-stale", status: "started" };
      });
    // Both fences stay current through the helper's five safety checks. One
    // independent fact changes before the caller classifies accepted delivery.
    let lifecycleChecks = 0;
    let ownershipChecks = 0;
    const clearRecovery = vi.fn(() =>
      clearSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey),
    );

    await expect(
      advanceSessionPlacementDraft(
        request,
        recoveryRecord(sessionKey, "interrupted task", { messageId: "message-interrupted" }),
        {
          isLifecycleCurrent: () => {
            lifecycleChecks += 1;
            return lifecycleCurrent || lifecycleChecks < 6;
          },
          ownsRecovery: () => {
            ownershipChecks += 1;
            return recoveryOwned || ownershipChecks < 6;
          },
          clearRecovery,
        },
      ),
    ).resolves.toEqual({ status });
    expect(clearRecovery).toHaveBeenCalledWith(retirement);
    expect(
      readSessionPlacementRecovery(gatewayUrl, recoveryScope, newerRecovery.sessionKey),
    ).toEqual(recoveryOwned ? null : newerRecovery);
  });

  it.each([
    ["stale", "stale task", "message-stale"],
    ["incognito", "private task", "message-private"],
    ["cancelled", "cancelled task", "message-cancelled"],
  ] as const)("cancels a %s draft without losing recovery", async (id, message, messageId) => {
    const cleanupFails = id === "cancelled";
    const recovery = recoveryRecord("agent:cloud:" + id, message, { messageId });
    if (id === "stale") {
      storeRecovery(recoveryRecord("agent:cloud:newer", "newer task"));
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { sessionId: "session-" + id } })
      .mockResolvedValueOnce({ ok: true });
    if (cleanupFails) {
      request
        .mockRejectedValueOnce(new Error("delete unavailable"))
        .mockResolvedValueOnce({ ok: true });
    } else {
      request.mockResolvedValueOnce({ ok: true, deleted: true });
    }
    const clearRecovery = vi.fn();
    await expect(
      advanceSessionPlacementDraft(request, recovery, {
        persistRecovery: id !== "incognito",
        isLifecycleCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery,
      }),
    ).resolves.toEqual(
      cleanupFails
        ? { status: "cancelled", cleanupError: "delete unavailable", recoveryPersisted: true }
        : { status: "cancelled", recoveryPersisted: false },
    );
    if (cleanupFails) {
      expect(
        JSON.parse(sessionStorage.getItem(recoveryStorageKey(recovery.sessionKey)) ?? "null"),
      ).toMatchObject({ sessionKey: "agent:cloud:cancelled" });
      expect(clearRecovery).not.toHaveBeenCalled();
      expect(request).toHaveBeenLastCalledWith("sessions.patch", {
        key: recovery.sessionKey,
        agentId: "cloud",
        archived: false,
        expectedSessionId: "session-cancelled",
      });
    } else if (id === "stale") {
      expect(
        JSON.parse(sessionStorage.getItem(recoveryStorageKey("agent:cloud:newer")) ?? "null"),
      ).toMatchObject({ sessionKey: "agent:cloud:newer" });
      expect(clearRecovery).toHaveBeenCalledOnce();
    } else {
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "sessions.describe",
        "sessions.patch",
        "sessions.delete",
      ]);
      expect(sessionStorage.length).toBe(0);
    }
  });

  it("pauses uncertain delivery without allocating after terminal placement", async () => {
    const recovery = recoveryRecord("agent:cloud:recovered", "possibly accepted task", {
      phase: "sending",
      target: { kind: "profile", profileId: "aws", machineClass: "fast" },
    });
    storeRecovery(recovery);
    const request = vi.fn().mockResolvedValueOnce({ messages: [] });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft(request, recovery, { mode: "recover", clearRecovery }),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "unconfirmed",
        messageId: "message-recovered",
        message: "possibly accepted task",
      },
    });
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(0);
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("keeps the visible session after a definitive redispatch rejection", async () => {
    storeRecovery(recoveryRecord("agent:cloud:recovered", "retry this task", { phase: "sending" }));
    const request = vi.fn().mockRejectedValueOnce(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "cloud profile was removed",
        retryable: false,
      }),
    );
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft(
        request,
        recoveryRecord("agent:cloud:recovered", "retry this task"),
        { clearRecovery },
      ),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "not-sent",
        error: "cloud profile was removed",
        message: "retry this task",
      },
    });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("clears recovery when its draft session no longer exists", async () => {
    storeRecovery(recoveryRecord("agent:cloud:missing", "missing task"));
    const request = vi.fn().mockResolvedValueOnce({ session: null });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft(request, recoveryRecord("agent:cloud:missing", "missing task"), {
        mode: "recover",
        clearRecovery,
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it("keeps a terminal recovery session visible before first-turn sending", async () => {
    storeRecovery(recoveryRecord("agent:cloud:pre-send", "not sent yet"));
    const request = vi.fn().mockResolvedValueOnce({ session: { placement: { state: "failed" } } });
    const clearRecovery = vi.fn();

    await expect(
      advanceSessionPlacementDraft(
        request,
        recoveryRecord("agent:cloud:pre-send", "not sent yet"),
        { mode: "recover", clearRecovery },
      ),
    ).resolves.toMatchObject({
      status: "paused",
      recovery: {
        reason: "not-sent",
        message: "not sent yet",
        error: "session placement became failed",
      },
    });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });
});
