// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionGoal } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatGoalCreationObjective, chatGoalRecovery } from "./chat-goals.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  dialogs = createModalDialogTestFixture();
});
afterEach(async () => {
  await dialogs.cleanup();
  vi.unstubAllGlobals();
});
const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-a",
  objective: "Review the deployment",
  status: "paused",
  createdAt: 1,
  updatedAt: 2,
  pausedAt: 2,
  tokenStart: 100,
  tokensUsed: 12_400,
  tokenBudget: 50_000,
  continuationTurns: 3,
};
function fixture(
  update: unknown = {
    status: "updated",
    goalId: goal.id,
    goal: { ...goal, objective: "Write rollout notes", updatedAt: 3 },
  },
) {
  const row = {
    key: "agent:main:main",
    agentId: "main",
    sessionId: "session-a",
    kind: "direct" as const,
    updatedAt: 2,
    goal: { ...goal },
  };
  const host = makeChatHost({
    sessionKey: row.key,
    currentSessionId: row.sessionId,
    chatMessage: "/goal Write rollout notes",
    sessionsResult: { ...createSessionsListResult(), sessions: [row] },
    requestHandlers: { "sessions.goal.update": update },
  });
  onTestFinished(() => host.sessions.dispose());
  return { host, row };
}
async function answer(label: string) {
  const actions = await waitForConfirmDialogActions();
  const control = [...actions.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(control).toBeDefined();
  control!.click();
}
it.each(["edit", "replace", "structured"] as const)(
  "confirms an existing goal through %s",
  async (mode) => {
    const running = mode !== "edit";
    const { host, row } = fixture({
      status: running ? "started" : "updated",
      goalId: goal.id,
      ...(running ? { action: "replace", runId: "resumed-turn" } : {}),
      goal: {
        ...goal,
        status: running ? "active" : "paused",
        objective: "Write rollout notes",
        updatedAt: 3,
      },
    });
    if (running) {
      row.goal.status = "active";
      host.chatRunId = "original-turn";
      host.chatSending = true;
    }
    if (mode === "structured") {
      host.chatMessage = "Write rollout notes";
    }
    const pending = dialogs.track(
      handleSendChat(
        host,
        undefined,
        mode === "structured"
          ? { intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } }
          : undefined,
      ),
    );
    await answer("Replace objective");
    expect(await pending).toBe(true);
    expect(requestCalls(host.request, "sessions.goal.update")[0]?.[1]).toMatchObject({
      action: running ? "replace" : "edit",
      goalId: goal.id,
      sessionId: "session-a",
      objective: "Write rollout notes",
      ...(running ? { expectedRunId: "original-turn", expectedGoalUpdatedAt: goal.updatedAt } : {}),
    });
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(requestCalls(host.request, "sessions.goal.clear")).toHaveLength(0);
    if (running) {
      expect(host.chatRunId).toBe("resumed-turn");
    } else {
      expect(host.chatMessage).toBe("");
    }
  },
);
it("opens confirmation during an executing goal and cancels without stopping work", async () => {
  const { host, row } = fixture();
  row.goal.status = "active";
  host.chatRunId = "running-goal-turn";
  host.chatSending = true;
  const draft = host.chatMessage;
  const pending = dialogs.track(handleSendChat(host));
  await answer("Cancel");
  expect(await pending).toBe(false);
  expect(host.chatRunId).toBe("running-goal-turn");
  expect(host.chatMessage).toBe(draft);
  expect(requestCalls(host.request, "sessions.abort")).toHaveLength(0);
  expect(requestCalls(host.request, "sessions.goal.update")).toHaveLength(0);
});

it.each(["finished", "new turn"])(
  "does not replace after the confirmed turn %s",
  async (transition) => {
    const { host, row } = fixture();
    row.goal.status = "active";
    host.chatRunId = "original-turn";
    host.chatSending = true;
    const pending = dialogs.track(handleSendChat(host));
    await waitForConfirmDialogActions();
    host.chatRunId = transition === "finished" ? null : "newer-turn";
    host.chatSending = transition !== "finished";
    await answer("Replace objective");
    expect(await pending).toBe(false);
    expect(requestCalls(host.request, "sessions.goal.update")).toHaveLength(0);
  },
);
it("retains the proposal on cancel and a failed edit, with the existing recovery receipt", async () => {
  const failed = createDeferred<never>();
  const { host } = fixture(() => failed.promise);
  const draft = host.chatMessage;
  const cancelled = dialogs.track(handleSendChat(host));
  await answer("Cancel");
  expect(await cancelled).toBe(false);
  expect(host.chatMessage).toBe(draft);
  expect(requestCalls(host.request, "sessions.goal.update")).toHaveLength(0);
  const saving = dialogs.track(handleSendChat(host));
  await answer("Replace objective");
  await vi.waitFor(() => expect(chatGoalRecovery(host)?.pending).toBe(true));
  failed.reject(new Error("Save failed"));
  expect(await saving).toBe(false);
  expect(host.chatMessage).toBe(draft);
  expect(host.chatError).toContain("Save failed");
  expect(chatGoalRecovery(host)?.action).toBe("edit");
  expect(await handleSendChat(host)).toBe(false);
  expect(requestCalls(host.request, "sessions.goal.update")).toHaveLength(1);
});
it.each([
  { change: "session", host: { sessionKey: "agent:main:other" } },
  { change: "incarnation", host: { currentSessionId: "session-b" } },
  { change: "connection", host: { connectionEpoch: 1 } },
  { change: "goal", goal: { id: "goal-b" } },
  { change: "objective", goal: { objective: "Newer objective" } },
  { change: "status", goal: { status: "complete" } },
  { change: "revision", goal: { updatedAt: 4 } },
  { change: "offline", host: { connected: false } },
  { change: "busy", host: { chatSending: true } },
] satisfies Array<{
  change: string;
  host?: Partial<ReturnType<typeof fixture>["host"]>;
  goal?: Partial<SessionGoal>;
}>)("does not apply a pending decision after $change changes", async (change) => {
  const { host, row } = fixture();
  const draft = host.chatMessage;
  const pending = dialogs.track(handleSendChat(host));
  await waitForConfirmDialogActions();
  Object.assign(host, change.host);
  Object.assign(row.goal, change.goal);
  await answer("Replace objective");
  expect(await pending).toBe(false);
  expect(requestCalls(host.request, "sessions.goal.update")).toHaveLength(0);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  expect(host.chatMessage).toBe(draft);
});
it("preserves a newer composer draft while an accepted edit is saving", async () => {
  const result = createDeferred<unknown>();
  const { host } = fixture(() => result.promise);
  const pending = dialogs.track(handleSendChat(host));
  await answer("Replace objective");
  await vi.waitFor(() => expect(chatGoalRecovery(host)?.pending).toBe(true));
  host.chatMessage = "A newer conversation draft";
  result.resolve({
    status: "updated",
    goalId: goal.id,
    goal: { ...goal, objective: "Write rollout notes", updatedAt: 3 },
  });
  expect(await pending).toBe(true);
  expect(host.chatMessage).toBe("A newer conversation draft");
});
it("keeps completed goals read-only rather than clearing or resuming them", async () => {
  const { host, row } = fixture();
  row.goal.status = "complete";
  expect(await handleSendChat(host)).toBe(false);
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(requestCalls(host.request, "sessions.goal.update")).toHaveLength(0);
  expect(host.chatError).toContain("Goal editing is unavailable");
});
it.each(["status", "edit", "pause", "resume", "complete", "done", "block", "blocked", "clear"])(
  "leaves explicit %s syntax alone",
  (action) => {
    expect(chatGoalCreationObjective("/goal " + action + " note")).toBeUndefined();
  },
);
it.each(["", "start", "set", "create"])(
  "parses creation alias %s as the literal objective",
  (action) => {
    expect(chatGoalCreationObjective(`/goal ${action} Write rollout notes`)).toBe(
      "Write rollout notes",
    );
  },
);
it("preserves literal objective formatting and ignores non-goal commands", () => {
  expect(chatGoalCreationObjective(" /GOAL start First line\n  second   line ")).toBe(
    "First line\n  second   line",
  );
  for (const command of ["/goal", "/goal start", "/goals next", "/goal: next", "ordinary text"]) {
    expect(chatGoalCreationObjective(command)).toBeUndefined();
  }
});
