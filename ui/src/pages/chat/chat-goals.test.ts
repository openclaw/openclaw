// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SessionsGoalUpdateParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionsListResult, SessionGoal } from "../../api/types.ts";
import { retireStoredGoalOperations } from "../../lib/chat/goal-operation-storage.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatGoalRecovery, mutateChatGoal } from "./chat-goals.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-a",
  objective: "Review the UI",
  status: "paused",
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 10,
  continuationTurns: 0,
};

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function goalHost(requestHandlers: Record<string, unknown>) {
  const host = makeChatHost({
    sessionKey: "agent:main:main",
    currentSessionId: "session-a",
    chatMessage: "Unrelated draft",
    sessionsResult: {
      ...createSessionsListResult(),
      sessions: [
        {
          key: "agent:main:main",
          agentId: "main",
          sessionId: "session-a",
          kind: "direct",
          updatedAt: 2,
          goal,
        },
      ],
    },
    requestHandlers,
  });
  const sessions = host.sessions;
  const projectSessions = (state: typeof sessions.state) => {
    host.sessionsResult = state.result;
    host.sessionsResultAgentId = state.agentId;
  };
  projectSessions(sessions.state);
  const stop = sessions.subscribe(projectSessions);
  onTestFinished(() => {
    stop();
    sessions.dispose();
  });
  return host;
}

describe("Goal control requests", () => {
  it("rejects an oversized edit without stranding recovery or blocking a corrected edit", async () => {
    const host = goalHost({
      "sessions.goal.update": (params: unknown) => {
        if (!Value.Check(SessionsGoalUpdateParamsSchema, params)) {
          throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Invalid goal edit" });
        }
        return {
          status: "updated",
          goalId: goal.id,
          goal: {
            ...goal,
            objective: "objective" in params ? params.objective : goal.objective,
            updatedAt: 3,
          },
        };
      },
    });
    expect(
      await mutateChatGoal(host, {
        action: "edit",
        goalId: goal.id,
        objective: "x".repeat(16_001),
      }),
    ).toBe(false);
    expect.soft(host.request).not.toHaveBeenCalled();
    expect.soft(sessionStorage.length).toBe(0);
    expect.soft(chatGoalRecovery(host)).toBeUndefined();
    expect.soft(host.chatError).toBeTruthy();

    const objective = "x".repeat(16_000);
    expect(await mutateChatGoal(host, { action: "edit", goalId: goal.id, objective })).toBe(true);
    expect(host.sessions.state.result?.sessions[0]?.goal?.objective).toBe(objective);
    expect(host.chatError).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(chatGoalRecovery(host)).toBeUndefined();
  });

  it("edits literal objective text through the typed owner and leaves the chat draft alone", async () => {
    const objective = "  /goal clear\n  is literal text ";
    const host = goalHost({
      "sessions.goal.update": {
        status: "updated",
        goalId: goal.id,
        goal: { ...goal, objective, updatedAt: 3 },
      },
    });
    expect(await mutateChatGoal(host, { action: "edit", goalId: goal.id, objective })).toBe(true);
    expect(host.request).toHaveBeenCalledWith(
      "sessions.goal.update",
      expect.objectContaining({
        sessionKey: host.sessionKey,
        sessionId: "session-a",
        goalId: goal.id,
        operationId: expect.any(String),
        issuedAtMs: expect.any(Number),
        action: "edit",
        objective,
      }),
      { timeoutMs: 30_000 },
    );
    expect(host.sessions.state.result?.sessions[0]?.goal?.objective).toBe(objective);
    expect(host.chatMessage).toBe("Unrelated draft");
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("adopts a fresh Resume run without inventing a user message", async () => {
    const host = goalHost({
      "sessions.goal.update": {
        status: "started",
        goalId: goal.id,
        runId: "resume-run",
        goal: { ...goal, status: "active", updatedAt: 3 },
      },
    });
    expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(true);
    expect(host.chatRunId).toBe("resume-run");
    expect(host.chatMessages).toEqual([]);
    expect(host.chatMessage).toBe("Unrelated draft");
  });

  it.each(["reconnect", "reload"])(
    "reconciles a lost ACK after %s without resurrecting the run",
    async (recovery) => {
      let fail = true;
      const handlers = {
        "sessions.goal.update": () => {
          if (fail) {
            throw new GatewayRequestError({ code: "UNAVAILABLE", message: "ACK lost" });
          }
          return {
            status: "started",
            goalId: goal.id,
            runId: "old-resume-run",
            replayed: true,
            goal: { ...goal, status: "active", updatedAt: 3 },
          };
        },
      };
      let host = goalHost(handlers);
      expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
      const firstRequest = host.request.mock.calls.find(
        ([method]) => method === "sessions.goal.update",
      )?.[1];
      fail = false;
      if (recovery === "reload") {
        host = goalHost(handlers);
      } else {
        host.client = createTestGatewayClient(host.request);
        host.connectionEpoch += 1;
      }
      retireStoredGoalOperations(host.settings.gatewayUrl ?? "", host.client!.recoveryScope);
      const refresh = vi.spyOn(host.sessions, "refresh").mockResolvedValue();
      host.sessions.patchRowLocal(host.sessionKey, {
        goal: { ...goal, status: "active", updatedAt: 3 },
      });
      expect(chatGoalRecovery(host)).toMatchObject({ pending: false });
      expect(await chatGoalRecovery(host)?.onCheck()).toBe(true);
      const requests = host.request.mock.calls.filter(
        ([method]) => method === "sessions.goal.update",
      );
      expect(requests.at(-1)?.[1]).toEqual(firstRequest);
      expect(requests.at(-1)?.[2]).toMatchObject({ timeoutMs: 30_000 });
      expect(sessionStorage.length).toBe(0);
      expect(refresh).toHaveBeenCalledOnce();
      expect(host.chatRunId).toBeNull();
      expect(host.sessions.state.result?.sessions[0]?.goal?.status).toBe("active");
    },
  );

  it("never sends or carries a private edit across clients with no recovery owner", async () => {
    const host = goalHost({
      "sessions.goal.update": () => {
        throw new Error("ACK lost");
      },
    });
    let renderedError: string | null | undefined;
    host.requestUpdate = () => {
      renderedError = host.chatError;
    };
    Object.defineProperty(host.client, "recoveryScope", { get: () => "" });
    await mutateChatGoal(host, {
      action: "edit",
      goalId: goal.id,
      objective: "Private account A edit",
    });
    const captured = chatGoalRecovery(host);
    expect
      .soft(renderedError)
      .toBe("Goal update was not sent because its recovery request could not be saved.");
    expect.soft(host.request).not.toHaveBeenCalled();
    expect.soft(sessionStorage.length).toBe(0);
    // Credentials changed, but both clients lack a distinguishable scope and share a session.
    host.client = createTestGatewayClient(host.request);
    Object.defineProperty(host.client, "recoveryScope", { get: () => "" });
    host.connectionEpoch += 1;
    retireStoredGoalOperations(host.settings.gatewayUrl ?? "", host.client.recoveryScope);
    expect.soft(chatGoalRecovery(host)).toBeUndefined();
    await captured?.onCheck();
    await chatGoalRecovery(host)?.onCheck();
    expect(host.request).not.toHaveBeenCalled();
  });

  it.each(["gateway", "principal", "session"])(
    "does not restore another %s's request",
    async (boundary) => {
      const first = goalHost({
        "sessions.goal.update": () => {
          throw new Error("ACK lost");
        },
      });
      await mutateChatGoal(first, { action: "resume", goalId: goal.id });
      const original = first.request.mock.calls[0]?.[1];
      const next = goalHost({
        "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
      });
      if (boundary === "gateway") {
        next.settings.gatewayUrl = "ws://another.invalid";
      }
      if (boundary === "principal") {
        Object.defineProperty(next.client, "recoveryScope", { get: () => "another-principal" });
      }
      if (boundary === "session") {
        next.currentSessionId = "replacement-session";
      }
      await mutateChatGoal(next, { action: "resume", goalId: goal.id });
      expect(next.request.mock.calls[0]?.[1]).not.toEqual(original);
    },
  );

  it("does not send if recovery storage fails, but keeps incognito recovery in memory", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    vi.stubGlobal("sessionStorage", storage);
    const host = goalHost({
      "sessions.goal.update": () => {
        throw new Error("ACK lost");
      },
    });
    expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    expect(host.request).not.toHaveBeenCalled();
    host.selectedChatSessionIncognito = true;
    await mutateChatGoal(host, { action: "resume", goalId: goal.id });
    await mutateChatGoal(host, { action: "resume", goalId: goal.id });
    expect(host.request.mock.calls[0]?.[1]).toEqual(host.request.mock.calls[1]?.[1]);
    expect(storage.length).toBe(0);
  });

  it("restores Clear after the authoritative goal disappeared, without executing on discovery", async () => {
    const first = goalHost({
      "sessions.goal.clear": () => {
        throw new Error("ACK lost");
      },
    });
    await mutateChatGoal(first, { action: "clear", goalId: goal.id });
    const params = first.request.mock.calls[0]?.[1];
    const restored = goalHost({
      "sessions.goal.clear": { status: "cleared", goalId: goal.id, replayed: true },
    });
    restored.sessions.patchRowLocal(restored.sessionKey, { goal: undefined });
    const refresh = vi.spyOn(restored.sessions, "refresh").mockResolvedValue();
    expect(chatGoalRecovery(restored)).toMatchObject({ pending: false });
    expect(restored.request).not.toHaveBeenCalled();
    expect(await chatGoalRecovery(restored)?.onCheck()).toBe(true);
    expect(restored.request).toHaveBeenCalledWith("sessions.goal.clear", params, {
      timeoutMs: 30_000,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(chatGoalRecovery(restored)).toBeUndefined();
  });

  it("QA retains the expired recovery fence when the real session roster refresh fails", async () => {
    const first = goalHost({
      "sessions.goal.update": () => {
        throw new Error("ACK lost");
      },
    });
    await mutateChatGoal(first, { action: "edit", goalId: goal.id, objective: "Private edit" });
    const original = first.request.mock.calls[0]?.[1];
    if (!isRecord(original) || typeof original.issuedAtMs !== "number") {
      throw new Error("Expected the original Goal operation timestamp");
    }
    vi.spyOn(Date, "now").mockReturnValue(original.issuedAtMs + 24 * 60 * 60 * 1000);
    const restored = goalHost({
      "sessions.list": () => {
        throw new Error("Synthetic roster unavailable");
      },
      "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
    });
    expect(chatGoalRecovery(restored)).toMatchObject({ retired: "expired" });
    const outcome = await chatGoalRecovery(restored)?.onCheck();
    expect(restored.request.mock.calls.some(([method]) => method === "sessions.list")).toBe(true);
    expect(restored.sessions.state.error).toContain("Synthetic roster unavailable");
    expect.soft(outcome, "A failed authoritative read must not retire recovery").toBe(false);
    expect.soft(chatGoalRecovery(restored)).toMatchObject({ retired: "expired" });
    expect.soft(sessionStorage.length).toBe(1);
    expect.soft(await mutateChatGoal(restored, { action: "resume", goalId: goal.id })).toBe(false);
    const newMutations = restored.request.mock.calls.filter(
      ([method]) => method === "sessions.goal.update",
    );
    expect.soft(newMutations).toHaveLength(0);
    if (newMutations[0]) {
      expect(newMutations[0][1]).not.toMatchObject({ operationId: original.operationId });
    }
  });

  async function expireSavedEdit() {
    const first = goalHost({
      "sessions.goal.update": () => {
        throw new Error("ACK lost");
      },
    });
    await mutateChatGoal(first, { action: "edit", goalId: goal.id, objective: "Private edit" });
    const original = first.request.mock.calls[0]?.[1];
    if (!isRecord(original) || typeof original.issuedAtMs !== "number") {
      throw new Error("Expected saved Goal identity");
    }
    vi.spyOn(Date, "now").mockReturnValue(original.issuedAtMs + 24 * 60 * 60 * 1000);
  }

  const observedRoster = (): SessionsListResult => ({
    ...createSessionsListResult(),
    sessions: [
      { key: "agent:main:main", sessionId: "session-a", kind: "direct", updatedAt: 3, goal },
    ],
  });

  it.each([
    { label: "search", query: { search: "another conversation" } },
    { label: "archive", query: { archivedFilter: "active" as const } },
    { label: "page", query: { limit: 1, offset: 1 } },
  ])("retains recovery when a successful $label roster omits the target", async ({ query }) => {
    await expireSavedEdit();
    const host = goalHost({
      "sessions.list": {
        ...createSessionsListResult(),
        sessions: [{ key: "agent:main:another", kind: "direct", updatedAt: 3 }],
      },
      "sessions.describe": () => {
        throw new Error("Selected goal unavailable");
      },
      "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
    });
    await host.sessions.refresh({ ...query, force: true });
    expect(host.sessions.state.result?.sessions.some((row) => row.key === host.sessionKey)).toBe(
      false,
    );
    expect.soft(await chatGoalRecovery(host)?.onCheck()).toBe(false);
    expect
      .soft(host.request.mock.calls.filter(([method]) => method === "sessions.describe"))
      .toHaveLength(1);
    expect.soft(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
    expect.soft(sessionStorage.length).toBe(1);
    expect.soft(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    expect
      .soft(host.request.mock.calls.filter(([method]) => method.startsWith("sessions.goal.")))
      .toHaveLength(0);
  });

  it("QA retires an expired fence after an actual successful scoped roster read without a mutation", async () => {
    await expireSavedEdit();
    const host = goalHost({
      "sessions.list": observedRoster(),
      "sessions.describe": { session: observedRoster().sessions[0] },
    });
    expect(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe('"expired"');
    expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    expect(await chatGoalRecovery(host)?.onCheck()).toBe(true);
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
      1,
    );
    expect(
      host.request.mock.calls.filter(([method]) => method.startsWith("sessions.goal.")),
    ).toHaveLength(0);
    expect(chatGoalRecovery(host)).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  it("observes an archived target outside the page before retiring recovery", async () => {
    await expireSavedEdit();
    const described = {
      key: "agent:main:main",
      sessionId: "session-a",
      kind: "direct" as const,
      updatedAt: 4,
      archived: true,
      goal: { ...goal, objective: "Current archived goal", updatedAt: 4 },
    };
    const host = goalHost({
      "sessions.list": { ...createSessionsListResult(), sessions: [] },
      "sessions.describe": { session: described },
    });
    await host.sessions.refresh({ limit: 1, search: "another conversation", force: true });
    const held = host.sessions.observeRow({ key: host.sessionKey, agentId: "main" }, () => {});
    try {
      expect(await chatGoalRecovery(host)?.onCheck()).toBe(true);
      expect(host.request).toHaveBeenCalledWith(
        "sessions.describe",
        { key: host.sessionKey },
        { timeoutMs: 30_000 },
      );
      expect(held.row).toMatchObject(described);
      expect(host.sessions.state.result?.sessions).toEqual([]);
      expect(chatGoalRecovery(host)).toBeUndefined();
      expect(sessionStorage.length).toBe(0);
      expect(host.request.mock.calls.some(([method]) => method.startsWith("sessions.goal."))).toBe(
        false,
      );
    } finally {
      held.dispose();
    }
  });

  it("retains recovery when a target event invalidates the exact descriptor read", async () => {
    await expireSavedEdit();
    const pending = createDeferred<{ session: SessionsListResult["sessions"][number] | null }>();
    const host = goalHost({
      "sessions.list": observedRoster(),
      "sessions.describe": () => pending.promise,
    });
    const { gateway, emitEvent } = createGatewayHarness(host.client!);
    const sessions = createTestSessionCapability(gateway);
    host.sessions = sessions;
    const check = chatGoalRecovery(host)?.onCheck();
    try {
      await vi.waitFor(() =>
        expect(host.request.mock.calls.some(([method]) => method === "sessions.describe")).toBe(
          true,
        ),
      );
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { agentId: "main", key: host.sessionKey, reason: "goal" },
      });
      pending.resolve({ session: observedRoster().sessions[0] ?? null });
      expect(await check).toBe(false);
      expect(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
      expect(sessionStorage.length).toBe(1);
      expect(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    } finally {
      pending.resolve({ session: null });
      sessions.dispose();
    }
  });

  it("QA retains expired recovery when a real roster read is superseded by another agent query", async () => {
    await expireSavedEdit();
    const pending = createDeferred<SessionsListResult>();
    let reads = 0;
    const host = goalHost({
      "sessions.list": () =>
        ++reads === 1 ? pending.promise : { ...createSessionsListResult(), sessions: [] },
      "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
    });
    const check = chatGoalRecovery(host)?.onCheck();
    expect(reads).toBe(1);
    const replacement = host.sessions.refresh({ agentId: "another-agent", force: true });
    pending.resolve(observedRoster());
    const outcome = await check;
    await replacement;
    expect(host.sessions.state.agentId).toBe("another-agent");
    expect.soft(outcome).toBe(false);
    expect.soft(sessionStorage.length).toBe(1);
    expect.soft(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
    expect.soft(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    expect
      .soft(host.request.mock.calls.filter(([method]) => method === "sessions.goal.update"))
      .toHaveLength(0);
  });

  it("QA retains the original fence after the visible target changes during the roster read", async () => {
    await expireSavedEdit();
    const pending = createDeferred<SessionsListResult>();
    const host = goalHost({
      "sessions.list": () => pending.promise,
      "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
    });
    const originalSessionKey = host.sessionKey;
    const originalSessionId = host.currentSessionId;
    const check = chatGoalRecovery(host)?.onCheck();
    host.sessionKey = "agent:main:replacement";
    host.currentSessionId = "replacement-session";
    pending.resolve(observedRoster());
    expect.soft(await check).toBe(false);
    expect.soft(sessionStorage.length).toBe(1);
    host.sessionKey = originalSessionKey;
    host.currentSessionId = originalSessionId;
    expect.soft(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
    expect.soft(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
    expect
      .soft(host.request.mock.calls.filter(([method]) => method === "sessions.goal.update"))
      .toHaveLength(0);
  });

  it("QA retains recovery when the real connection retires an in-flight roster read", async () => {
    await expireSavedEdit();
    const pending = createDeferred<SessionsListResult>();
    const host = goalHost({
      "sessions.list": () => pending.promise,
      "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
    });
    const { gateway, publish } = createGatewayHarness(host.client!);
    const sessions = createTestSessionCapability(gateway);
    sessions.reconcile(observedRoster().sessions[0]);
    host.sessions = sessions;
    const check = chatGoalRecovery(host)?.onCheck();
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
      1,
    );
    const newHost = goalHost({
      "sessions.list": () => {
        throw new Error("Replacement unavailable");
      },
      "sessions.subscribe": { subscribed: true },
      "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
    });
    host.client = newHost.client;
    host.connectionEpoch += 1;
    publish(false);
    publish(true, host.client);
    pending.resolve(observedRoster());
    try {
      expect.soft(await check).toBe(false);
      expect.soft(sessionStorage.length).toBe(1);
      expect.soft(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
      expect.soft(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
      expect
        .soft(newHost.request.mock.calls.filter(([method]) => method === "sessions.goal.update"))
        .toHaveLength(0);
    } finally {
      sessions.dispose();
    }
  });

  it("retains same-principal recovery on reconnect but retires old-account payloads", async () => {
    const host = goalHost({
      "sessions.goal.update": () => {
        throw new Error("ACK lost");
      },
    });
    await mutateChatGoal(host, {
      action: "edit",
      goalId: goal.id,
      objective: "Private literal edit",
    });
    retireStoredGoalOperations(host.settings.gatewayUrl ?? "", host.client!.recoveryScope);
    expect(chatGoalRecovery(host)).toBeDefined();
    retireStoredGoalOperations(host.settings.gatewayUrl ?? "", "different-principal");
    expect(sessionStorage.length).toBe(0);
    expect(chatGoalRecovery(host)).toBeUndefined();
    expect(host.request).toHaveBeenCalledOnce();
  });

  it("does not let a captured recovery button reconcile another conversation", async () => {
    const host = goalHost({
      "sessions.goal.update": () => {
        throw new Error("ACK lost");
      },
    });
    await mutateChatGoal(host, { action: "resume", goalId: goal.id });
    const firstRecovery = chatGoalRecovery(host);
    host.sessionKey = "agent:main:other";
    host.currentSessionId = "session-b";
    await mutateChatGoal(host, { action: "resume", goalId: "goal-b" });
    expect(host.request).toHaveBeenCalledTimes(2);
    await firstRecovery?.onCheck();
    expect(host.request).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid", "goal-invalid"])(
    "retires definitive %s rejection instead of arming a future mutation",
    async (reason) => {
      const pending = createDeferred<never>();
      const host = goalHost({ "sessions.goal.update": () => pending.promise });
      const submitted = mutateChatGoal(host, { action: "resume", goalId: goal.id });
      const captured = chatGoalRecovery(host);
      pending.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "goal is already complete",
          details: reason === "invalid" ? { code: "GOAL_OPERATION_REJECTED", reason } : { reason },
        }),
      );
      expect(await submitted).toBe(false);
      expect(host.chatError).toContain("goal is already complete");
      expect(chatGoalRecovery(host)).toBeUndefined();
      expect(sessionStorage.length).toBe(0);
      await captured?.onCheck();
      expect(host.request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { reason: "expired", crossesBoundary: true },
    { reason: "goal-expired", crossesBoundary: false },
  ])(
    "retains a payload-free fence on server $reason (clock crosses boundary=$crossesBoundary)",
    async ({ reason, crossesBoundary }) => {
      const pending = createDeferred<never>();
      let requests = 0;
      const host = goalHost({
        "sessions.goal.update": () => {
          if (++requests === 1) {
            throw new Error("ACK lost");
          }
          return pending.promise;
        },
      });
      await mutateChatGoal(host, { action: "edit", goalId: goal.id, objective: "Private edit" });
      const original = host.request.mock.calls[0]?.[1];
      if (!isRecord(original) || typeof original.issuedAtMs !== "number") {
        throw new Error("Expected saved Goal timestamp");
      }
      const expiresAt = original.issuedAtMs + 24 * 60 * 60 * 1000;
      const now = vi.spyOn(Date, "now").mockReturnValue(expiresAt - 1);
      const check = chatGoalRecovery(host)?.onCheck();
      expect(host.request.mock.calls[1]?.[1]).toEqual(original);
      // The server can cross its receipt boundary in flight or have a clock ahead of the UI.
      if (crossesBoundary) {
        now.mockReturnValue(expiresAt + 1);
      }
      pending.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Goal operation expired; review the current Goal before trying again.",
          details: reason === "expired" ? { code: "GOAL_OPERATION_REJECTED", reason } : { reason },
        }),
      );
      expect(await check).toBe(false);
      expect.soft(chatGoalRecovery(host)).toMatchObject({ retired: "expired" });
      expect.soft(sessionStorage.getItem(sessionStorage.key(0)!)).toBe('"expired"');
      expect.soft(await mutateChatGoal(host, { action: "resume", goalId: goal.id })).toBe(false);
      expect.soft(requests).toBe(2);
      const reloaded = goalHost({
        "sessions.list": () => {
          throw new Error("Current goal unavailable");
        },
      });
      expect.soft(chatGoalRecovery(reloaded)).toMatchObject({ retired: "expired" });
      expect.soft(await chatGoalRecovery(reloaded)?.onCheck()).toBe(false);
      expect.soft(chatGoalRecovery(reloaded)).toMatchObject({ retired: "expired" });
    },
  );

  it("keeps a corrupt receipt outcome bound to the original identity", async () => {
    const host = goalHost({
      "sessions.goal.update": () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Stored Goal operation receipt is invalid",
          details: { code: "GOAL_OPERATION_REJECTED", reason: "receipt-invalid" },
        });
      },
    });
    await mutateChatGoal(host, { action: "resume", goalId: goal.id });
    expect(chatGoalRecovery(host)).toBeDefined();
    await chatGoalRecovery(host)?.onCheck();
    expect(host.request.mock.calls[1]?.[1]).toEqual(host.request.mock.calls[0]?.[1]);
  });

  it("does not apply a delayed clear to a replacement goal", async () => {
    const pending = createDeferred<{ status: string; goalId: string }>();
    const host = goalHost({ "sessions.goal.clear": () => pending.promise });
    const clear = mutateChatGoal(host, { action: "clear", goalId: goal.id });
    host.sessions.patchRowLocal(host.sessionKey, { goal: { ...goal, id: "replacement-goal" } });
    pending.resolve({ status: "cleared", goalId: goal.id });
    await clear;
    expect(host.sessions.state.result?.sessions[0]?.goal?.id).toBe("replacement-goal");
  });

  it("does not adopt a delayed Resume after the goal was replaced", async () => {
    const pending = createDeferred<{ status: string; goalId: string; runId: string }>();
    const host = goalHost({ "sessions.goal.update": () => pending.promise });
    const resume = mutateChatGoal(host, { action: "resume", goalId: goal.id });
    host.sessions.patchRowLocal(host.sessionKey, { goal: { ...goal, id: "replacement-goal" } });
    pending.resolve({ status: "started", goalId: goal.id, runId: "old-goal-run" });
    expect(await resume).toBe(true);
    expect(host.chatRunId).toBeNull();
  });

  it("does not apply a delayed Resume to a different visible session", async () => {
    const pending = createDeferred<{ status: string; goalId: string; runId: string }>();
    const host = goalHost({ "sessions.goal.update": () => pending.promise });
    const resume = mutateChatGoal(host, { action: "resume", goalId: goal.id });
    host.sessionKey = "agent:main:other";
    host.currentSessionId = "session-b";
    pending.resolve({ status: "started", goalId: goal.id, runId: "old-session-run" });
    expect(await resume).toBe(true);
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessage).toBe("Unrelated draft");
  });
});
