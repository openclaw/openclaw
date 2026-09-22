/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_RUN_ACTIVITY_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import type { ChatPaneBase } from "../pages/chat/chat-pane-base.ts";
import { disposeSidebarContextLifecycles } from "../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessionsHarness } from "../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { applyControlUiFaviconStatus } from "./control-ui-environment-presentation.runtime.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";
import { client, createGatewayHarness, flushMicrotasks } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

vi.mock("./control-ui-environment-presentation.runtime.ts", () => ({
  applyControlUiFaviconStatus: vi.fn(),
}));
const cleanups: Array<() => void> = [];

function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
  document.dispatchEvent(new Event("visibilitychange"));
}

function setup(mountPane = true) {
  const gatewayClient = client(async (method) =>
    method === "question.list" ? { questions: [] } : [],
  );
  const harness = createGatewayHarness(gatewayClient);
  harness.update({ hello: gatewayHelloForMethods(["question.list", "exec.approval.list"]) });
  const overlays = createApplicationOverlays(harness.gateway);
  const sessions = createSessionsHarness("main", ["agent:main:background"]);
  const context = {
    ...createContext(harness.gateway, sessions.sessions),
    overlays,
  };
  const shell = document.createElement("div");
  const pane = document.createElement("openclaw-chat-pane");
  let activity: ChatPaneBase["runActivity"] = {
    client: gatewayClient,
    agentId: "main",
    working: false,
    completion: null,
  };
  Object.defineProperty(pane, "runActivity", { get: () => activity });
  if (mountPane) {
    shell.append(pane);
  }
  document.body.append(shell);
  const disconnect = connectControlUiFavicon(shell, context);
  cleanups.push(() => {
    disconnect();
    overlays.dispose();
    shell.remove();
  });
  return {
    context,
    harness,
    sessions,
    publish: (next: NonNullable<ChatPaneBase["runActivity"]>) => {
      activity = next;
      pane.dispatchEvent(new Event(CHAT_RUN_ACTIVITY_CHANGED_EVENT, { bubbles: true }));
    },
    activity: () => activity!,
    disconnect,
  };
}

beforeEach(() => {
  vi.mocked(applyControlUiFaviconStatus).mockClear();
  visibility("visible");
});

afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup());
  disposeSidebarContextLifecycles();
  vi.restoreAllMocks();
});

describe("favicon status source wiring", () => {
  it("prioritizes live approvals, work, unseen completion and disconnection, then restores the original", async () => {
    const { harness, publish, activity } = setup();
    await flushMicrotasks();
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
    visibility("hidden");
    publish({ ...activity(), working: true });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("working");
    harness.emitApproval("approval", Date.now());
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("attention");
    publish({
      ...activity(),
      completion: { phase: "done", runId: "completed", sessionKey: "main", occurredAt: Date.now() },
    });
    harness.emitEvent("exec.approval.resolved", { id: "approval", decision: "allow-once" });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("working");
    publish({ ...activity(), working: false });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("done");
    harness.update({ phase: "reconnecting" });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("done");
    visibility("visible");
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("disconnected");
    harness.update({ phase: "connected" });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
  });

  it("ignores interrupted runs and clears an unseen completion when the selected agent changes", async () => {
    const { context, publish, activity } = setup();
    visibility("hidden");
    publish({
      ...activity(),
      completion: {
        phase: "interrupted",
        runId: "aborted",
        sessionKey: "main",
        occurredAt: Date.now(),
      },
    });
    await flushMicrotasks();
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
    publish({
      ...activity(),
      completion: { phase: "done", runId: "finished", sessionKey: "main", occurredAt: Date.now() },
    });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("done");
    context.agentSelection.set("work");
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
    context.agentSelection.set("main");
    await flushMicrotasks();
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
  });

  it.each([false, true])(
    "marks hidden roster completion without a pane (reconnect: %s)",
    async (reconnect) => {
      const { sessions, harness } = setup(false);
      const result = sessions.sessions.state.result!;
      const row = result.sessions[0]!;
      const publishStatus = (status: "running" | "done" | "failed") =>
        sessions.publish({
          result: { ...result, sessions: [{ ...row, status }] },
        });
      visibility("hidden");
      publishStatus("running");
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("working");
      publishStatus("failed");
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
      publishStatus("running");
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("working");
      if (reconnect) {
        harness.update({ phase: "reconnecting" });
        sessions.publish({ result: null });
        expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("disconnected");
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
      }
      publishStatus("done");
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("done");
      visibility("visible");
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
      visibility("hidden");
      publishStatus("done");
      await flushMicrotasks();
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
      publishStatus("running");
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("working");
      sessions.publish({ result: { ...result, sessions: [] } });
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
      publishStatus("done");
      await flushMicrotasks();
      expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
    },
  );

  it("clears resolved questions, retains pending questions on reconnect and retires the old Gateway", async () => {
    const { harness } = setup();
    await flushMicrotasks();
    const question = {
      id: "previous-gateway-question",
      agentId: "main",
      sessionKey: "main",
      status: "pending",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      questions: [
        {
          questionId: "decision",
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Continue", description: "Resume the run." }],
        },
      ],
    };
    harness.emitEvent("question.requested", question);
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("attention");
    harness.emitEvent("question.resolved", { id: question.id, status: "cancelled" });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
    harness.emitEvent("question.requested", { ...question, id: "second-question" });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("attention");
    harness.update({ phase: "reconnecting" });
    await flushMicrotasks();
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("attention");
    harness.gateway.connectionRevision += 1;
    harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
    harness.update({ client: null, phase: "connecting" });
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("disconnected");
  });

  it("restores the favicon and ignores later source events after teardown", async () => {
    const { harness, disconnect } = setup();
    harness.emitApproval("first", Date.now());
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("attention");
    disconnect();
    expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith("idle");
    vi.mocked(applyControlUiFaviconStatus).mockClear();
    harness.emitApproval("second", Date.now());
    visibility("hidden");
    await flushMicrotasks();
    expect(applyControlUiFaviconStatus).not.toHaveBeenCalled();
  });
});
