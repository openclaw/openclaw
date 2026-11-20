import { describe, expect, it, onTestFinished, vi } from "vitest";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { createSessionEventState, emitGatewayEvent } from "./chat-state.test-support.ts";
import {
  applySessionApprovalEvent,
  currentParticipantSessionApproval,
  projectSessionApprovalReplay as project,
  reconcileSessionApprovalEvent as reconcile,
} from "./session-approval-projection.ts";

const pendingPluginApproval = {
  id: "plugin:approval-1",
  status: "pending" as const,
  presentation: {
    kind: "plugin" as const,
    title: "Run Codex execution on node",
    description: "Allows node account access",
    detail: "Command: pnpm test\nWorking directory: /workspace",
    severity: "critical" as const,
    pluginId: "codex",
    toolName: null,
    agentId: "main",
    allowedDecisions: ["allow-once", "deny"] as const,
  },
  urlPath: "/approve/plugin%3Aapproval-1",
  createdAtMs: 1_000,
  expiresAtMs: 10_000,
};
const host = "agent:main:host";
const sourceSessionKey = "agent:main:cloud-child";
const replay = (sessionKey = host) => ({
  sessionKey,
  updatedAtMs: 2_000,
  approvals: [pendingPluginApproval],
  truncated: false,
});
const event = (sessionKey = host) => ({
  sessionKey,
  phase: "pending" as const,
  updatedAtMs: 2_000,
  approval: pendingPluginApproval,
});
const projected = (sessionKey = host) => ({
  id: "plugin:approval-1",
  request: { sessionKey },
});
const ancestorProjection = {
  ...projected(),
  kind: "plugin",
  pluginTitle: "Run Codex execution on node",
  pluginDetail: pendingPluginApproval.presentation.detail,
  sourceSessionKey,
};

describe("session approval projection", () => {
  it("preserves turn attribution in reviewer events and replay without weakening payload validation", () => {
    const turnActor = { id: "profile:pat", label: "Pat" };
    const approval = { ...pendingPluginApproval, turnActor };
    expect(project({ ...replay(), approvals: [approval] }, host)[0]?.request.turnActor).toEqual(
      turnActor,
    );
    expect(reconcile([], { ...event(), approval }, host)?.[0]?.request.turnActor).toEqual(
      turnActor,
    );
    expect(
      reconcile([], { ...event(), approval: { ...approval, unexpected: "private" } }, host),
    ).toBeNull();
  });

  it("projects only own-turn status, without creating a reviewable approval or retaining private fields", () => {
    const { state, request } = createSessionEventState({
      sessionKey: host,
      chatSessionApprovalQueue: [],
    });
    onTestFinished(() => vi.restoreAllMocks());
    const changed = vi.fn();
    onTestFinished(chatRunPresentation(state).subscribeNonText(changed));
    const status = {
      phase: "participant",
      sessionKey: host,
      updatedAtMs: 2_000,
      approvalId: "approval-1",
      runId: "run-1",
      participantId: "profile:pat",
      status: "pending",
      expiresAtMs: Date.now() + 60_000,
    };
    const own = () => currentParticipantSessionApproval(state, "main", "profile:pat");
    emitGatewayEvent(state, "session.approval", { ...status, command: "secret", detail: "secret" });
    expect(changed).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(own()).toEqual({
      approvalId: "approval-1",
      runId: "run-1",
      participantId: "profile:pat",
      expiresAtMs: status.expiresAtMs,
    });
    expect(state.chatSessionApprovalQueue).toEqual([]);
    expect(currentParticipantSessionApproval(state, "main", "profile:other")).toBeNull();
    expect(currentParticipantSessionApproval(state, "main", null)).toBeNull();
    expect(applySessionApprovalEvent(state, { ...status, sessionKey: "agent:main:other" })).toBe(
      false,
    );
    expect(applySessionApprovalEvent(state, { ...status, status: "terminal" })).toBe(true);
    expect(own()).toBeNull();
    applySessionApprovalEvent(state, { ...status, expiresAtMs: 1 });
    expect(own()).toBeNull();
    applySessionApprovalEvent(state, status);
    state.connectionEpoch++;
    expect(own()).toBeNull();
    applySessionApprovalEvent(state, status);
    chatHistoryRequests(state).subscriptionGeneration++;
    expect(own()).toBeNull();
  });

  it("projects replay into the subscribed host session", () => {
    const queue = project(
      { ...replay(), approvals: [{ ...pendingPluginApproval, sourceSessionKey }] },
      host,
    );

    expect(queue).toMatchObject([ancestorProjection]);
  });

  it("ignores malformed replay and live events", () => {
    expect(project({ approvals: [{}] }, host)).toEqual([]);
    expect(reconcile([], { sessionKey: host })).toBeNull();
  });

  it("ignores replay for a different session", () => {
    expect(project(replay("agent:main:other"), host)).toEqual([]);
  });

  it("tracks the source session for a live ancestor projection and removes terminal state", () => {
    const pending = reconcile([], { ...event(), sourceSessionKey });

    expect(pending).toMatchObject([ancestorProjection]);
    expect(
      reconcile(pending ?? [], {
        ...event(),
        sourceSessionKey,
        phase: "terminal",
        updatedAtMs: 3_000,
        approval: {
          ...pendingPluginApproval,
          status: "denied",
          decision: "deny",
          reason: "user",
          resolvedAtMs: 3_000,
        },
      }),
    ).toEqual([]);
  });

  it("projects only the selected agent's qualified global approval stream", () => {
    const stream = "agent:research:global";
    expect(project(replay(stream), "global", "research")).toMatchObject([projected("global")]);
    expect(project(replay(stream), "global", "main")).toEqual([]);
    expect(reconcile([], event(stream), "global", "research")).toMatchObject([projected("global")]);
    expect(reconcile([], event(stream), "global", "main")).toBeNull();
  });
});
