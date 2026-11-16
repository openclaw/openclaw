/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHAT_RUN_ACTIVITY_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import type { ChatPaneElement } from "../pages/chat/chat-pane.tsx";
import { disposeSidebarContextLifecycles } from "../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessionsHarness } from "../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { applyControlUiFaviconStatus } from "./control-ui-environment-presentation.runtime.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";
import { client, createGatewayHarness, flushMicrotasks } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

// mock-isolation: Observe source lifetimes without sharing the browser compositor’s DOM state.
vi.mock("./control-ui-environment-presentation.runtime.ts", () => ({
  applyControlUiFaviconStatus: vi.fn(),
  applyControlUiFaviconImage: vi.fn(),
  invalidateControlUiFaviconPalette: vi.fn(),
}));
const cleanups: Array<() => void> = [];

function status(value: Parameters<typeof applyControlUiFaviconStatus>[0], change?: () => void) {
  change?.();
  expect(applyControlUiFaviconStatus).toHaveBeenLastCalledWith(value);
}

function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
  document.dispatchEvent(new Event("visibilitychange"));
}

type Activity = NonNullable<ChatPaneElement["runActivity"]>;
function completion(phase: NonNullable<Activity["completion"]>["phase"], runId: string) {
  return { phase, runId, sessionKey: "main", occurredAt: Date.now() };
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
  const shell = document.body.appendChild(document.createElement("div"));
  const pane = document.createElement("openclaw-chat-pane");
  let activity: Activity = {
    client: gatewayClient,
    agentId: "main",
    working: false,
    completion: null,
  };
  if (mountPane) {
    shell.append(pane);
  }
  const disconnect = connectControlUiFavicon(shell, context, () =>
    pane.isConnected && shell.contains(pane) ? [{ runActivity: activity }] : [],
  );
  cleanups.push(() => {
    disconnect();
    overlays.dispose();
    shell.remove();
  });
  return {
    context,
    harness,
    sessions,
    publish: (next: Partial<Activity>) => {
      activity = { ...activity, ...next };
      pane.dispatchEvent(new Event(CHAT_RUN_ACTIVITY_CHANGED_EVENT, { bubbles: true }));
    },
    disconnect,
  };
}

beforeEach(() => {
  vi.mocked(applyControlUiFaviconStatus).mockClear();
  visibility("visible");
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  disposeSidebarContextLifecycles();
  vi.restoreAllMocks();
});

it("prioritizes live approvals, work, unseen completion and disconnection, then restores the original", async () => {
  const { harness, publish } = setup();
  await flushMicrotasks();
  status("idle");
  visibility("hidden");
  status("working", () => publish({ working: true }));
  status("attention", () => harness.emitApproval("approval", Date.now()));
  publish({ completion: completion("done", "completed") });
  status("working", () =>
    harness.emitEvent("exec.approval.resolved", { id: "approval", decision: "allow-once" }),
  );
  status("done", () => publish({ working: false }));
  status("done", () => harness.update({ phase: "reconnecting" }));
  status("disconnected", () => visibility("visible"));
  status("idle", () => harness.update({ phase: "connected" }));
});

it("ignores interrupted runs and clears an unseen completion when the selected agent changes", async () => {
  const { context, publish } = setup();
  visibility("hidden");
  publish({ completion: completion("interrupted", "aborted") });
  await flushMicrotasks();
  status("idle");
  status("done", () => publish({ completion: completion("done", "finished") }));
  status("idle", () => context.agentSelection.set("work"));
  context.agentSelection.set("main");
  await flushMicrotasks();
  status("idle");
});

it.each([false, true])(
  "marks hidden roster completion without a pane (reconnect: %s)",
  async (reconnect) => {
    const { sessions, harness } = setup(false);
    const result = sessions.sessions.state.result!;
    const row = result.sessions[0]!;
    const publishStatus = (nextStatus: "running" | "done" | "failed") =>
      sessions.publish({
        result: { ...result, sessions: [{ ...row, status: nextStatus }] },
      });
    visibility("hidden");
    status("working", () => publishStatus("running"));
    status("idle", () => publishStatus("failed"));
    status("working", () => publishStatus("running"));
    if (reconnect) {
      harness.update({ phase: "reconnecting" });
      sessions.publish({ result: null });
      status("disconnected");
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      status("idle");
    }
    status("done", () => publishStatus("done"));
    status("idle", () => visibility("visible"));
    visibility("hidden");
    publishStatus("done");
    await flushMicrotasks();
    status("idle");
    status("working", () => publishStatus("running"));
    sessions.publish({ result: { ...result, sessions: [] } });
    status("idle");
    publishStatus("done");
    await flushMicrotasks();
    status("idle");
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
    questions: [{ questionId: "decision", question: "Continue?", header: "Continue", options: [] }],
  };
  status("attention", () => harness.emitEvent("question.requested", question));
  status("idle", () =>
    harness.emitEvent("question.resolved", { id: question.id, status: "cancelled" }),
  );
  status("attention", () =>
    harness.emitEvent("question.requested", { ...question, id: "second-question" }),
  );
  harness.update({ phase: "reconnecting" });
  await flushMicrotasks();
  status("attention");
  harness.gateway.connectionRevision += 1;
  harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
  status("disconnected", () => harness.update({ client: null, phase: "connecting" }));
});

it("restores the favicon and ignores later source events after teardown", async () => {
  const { harness, disconnect } = setup();
  status("attention", () => harness.emitApproval("first", Date.now()));
  status("idle", () => disconnect());
  vi.mocked(applyControlUiFaviconStatus).mockClear();
  harness.emitApproval("second", Date.now());
  visibility("hidden");
  await flushMicrotasks();
  expect(applyControlUiFaviconStatus).not.toHaveBeenCalled();
});
