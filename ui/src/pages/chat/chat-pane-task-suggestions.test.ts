/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentsListResult,
  TaskSuggestion,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane as createChatPane,
} from "./chat-pane.test-support.ts";
import { renderChatTaskSuggestionTray } from "./components/chat-task-suggestions.ts";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:current",
  agentId: "main",
  createdAt: 1,
};

function createTestChatPane(params: Parameters<typeof createChatPane>[0]) {
  const result = createChatPane(params);
  const snapshot = result.pane.context.gateway.snapshot;
  snapshot.hello = gatewayHelloForMethods([
    ...(snapshot.hello?.features?.methods ?? []),
    "taskSuggestions.accept",
    "taskSuggestions.dismiss",
  ]);
  return result;
}

describe("chat pane task suggestion lifecycle", () => {
  it.each(["confirmed", "failed", "resolved", "session", "connection"] as const)(
    "reconciles a pending dismissal after %s",
    async (outcome) => {
      const dismissed = createDeferred<{ taskId: string; dismissed: boolean }>();
      const listed = createDeferred<TaskSuggestionsListResult>();
      let holdLists = outcome === "confirmed";
      let suggestions = [suggestion];
      const request = createGatewayRequestMock((method) =>
        method === "taskSuggestions.dismiss"
          ? dismissed.promise
          : holdLists
            ? listed.promise
            : Promise.resolve({ suggestions }),
      );
      const { pane, state } = createTestChatPane({
        client: createTestGatewayClient(request),
        sessions: createSessionCapabilityFixture(),
      });
      pane.taskSuggestions = [suggestion];
      const oldList = outcome === "confirmed" ? pane.refreshTaskSuggestions() : undefined;
      const pending = pane.resolveTaskSuggestion(suggestion, "dismiss");
      expect(pane.taskSuggestions).toEqual([]);
      await pane.resolveTaskSuggestion(suggestion, "dismiss");
      expect(
        request.mock.calls.filter(([method]) => method === "taskSuggestions.dismiss"),
      ).toHaveLength(1);
      if (outcome === "confirmed") {
        const pendingList = pane.refreshTaskSuggestions();
        holdLists = false;
        suggestions = [];
        dismissed.resolve({ taskId: suggestion.id, dismissed: true });
        await pending;
        listed.resolve({ suggestions: [suggestion] });
        await Promise.all([oldList, pendingList]);
        expect(pane.taskSuggestions).toEqual([]);
      } else if (outcome === "failed") {
        await pane.refreshTaskSuggestions();
        expect(pane.taskSuggestions).toEqual([]);
        const next = { ...suggestion, id: "task_next", title: "Next task" };
        suggestions = [suggestion, next];
        pane.taskSuggestions = [next];
        dismissed.reject(new Error("Dismissal unavailable"));
        await pending;
        expect(pane.taskSuggestions).toEqual([suggestion, next]);
        expect(state.chatError).toBe("Dismissal unavailable");
      } else {
        let expected: TaskSuggestion[] = [];
        if (outcome === "resolved") {
          suggestions = [];
          pane.handleTaskSuggestionEvent({
            action: "resolved",
            taskId: suggestion.id,
            resolution: "dismissed",
          });
        } else {
          if (outcome === "connection") {
            pane.connectionGeneration += 1;
          } else {
            state.sessionKey = "agent:main:other";
          }
          expected = [{ ...suggestion, id: "task_other", sessionKey: state.sessionKey }];
          pane.taskSuggestions = expected;
        }
        dismissed.reject(new Error("Old dismissal failed"));
        await pending;
        expect(pane.taskSuggestions).toEqual(expected);
        expect(state.chatError).toBeNull();
      }
    },
  );

  it("preserves refused-dismissal reconciliation when another dismissal succeeds", async () => {
    const next = { ...suggestion, id: "task_next", title: "Next task" };
    const firstDismiss = createDeferred<{ taskId: string; dismissed: boolean }>();
    const secondDismiss = createDeferred<{ taskId: string; dismissed: boolean }>();
    const oldList = createDeferred<TaskSuggestionsListResult>();
    let listCount = 0;
    let dismissCount = 0;
    const request = createGatewayRequestMock((method) => {
      if (method === "taskSuggestions.dismiss") {
        dismissCount += 1;
        return dismissCount === 1 ? firstDismiss.promise : secondDismiss.promise;
      }
      listCount += 1;
      return listCount === 1 ? oldList.promise : Promise.resolve({ suggestions: [suggestion] });
    });
    const { pane } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.taskSuggestions = [suggestion, next];
    const first = pane.resolveTaskSuggestion(suggestion, "dismiss");
    const second = pane.resolveTaskSuggestion(next, "dismiss");
    firstDismiss.resolve({ taskId: suggestion.id, dismissed: false });
    await first;
    secondDismiss.resolve({ taskId: next.id, dismissed: true });
    await second;
    oldList.resolve({ suggestions: [suggestion, next] });

    await vi.waitFor(() => expect(pane.taskSuggestions).toEqual([suggestion]));
  });

  it("surfaces clipboard failure through the pane error path", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn(() => false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });

    try {
      await pane.copyTaskSuggestionPrompt(suggestion);
    } finally {
      // The fallback restores focus on the next turn; drain it before jsdom teardown.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }

    expect(writeText).toHaveBeenCalledWith(suggestion.prompt);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(state.lastError).toBe("Couldn't copy the prompt to the clipboard");
    expect(state.chatError).toBe("Couldn't copy the prompt to the clipboard");
  });

  it("hides a launched task through early events and stale lists without changing sessions", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const next = { ...suggestion, id: "task_next", title: "Next task" };
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.accept"
        ? accepted.promise
        : Promise.resolve({ suggestions: [suggestion, next] } satisfies TaskSuggestionsListResult),
    );
    const { pane, state } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    state.lastError = "History unavailable";
    state.chatError = "Chat send failed";
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    pane.taskSuggestions = [suggestion, next];
    const container = document.createElement("div");
    const draw = () =>
      render(renderChatTaskSuggestionTray(pane.suggestionChatProps(true, false, false)), container);

    const pending = pane.resolveTaskSuggestion(suggestion, "accept");
    draw();
    expect(container.querySelector('[data-task-id="task_123"]')).toBeNull();
    expect(container.querySelector('[data-task-id="task_next"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    pane.handleTaskSuggestionEvent({
      action: "resolved",
      taskId: suggestion.id,
      resolution: "accepted",
    });
    await pane.refreshTaskSuggestions();
    expect(pane.taskSuggestions).toEqual([next]);
    await pane.resolveTaskSuggestion(suggestion, "accept");
    expect(request.mock.calls.filter(([method]) => method === "taskSuggestions.accept")).toEqual([
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "local" }],
    ]);
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });
    await pending;
    await pane.refreshTaskSuggestions();
    draw();
    expect(pane.taskSuggestions).toEqual([next]);
    expect(container.querySelector('[data-task-id="task_123"]')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(state.lastError).toBe("History unavailable");
    expect(state.chatError).toBe("Chat send failed");
    await pane.resolveTaskSuggestion(suggestion, "accept");
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.accept"),
    ).toHaveLength(1);
  });

  it("recovers a worktree source on the same card without changing the prompt or launch mode", async () => {
    let attempts = 0;
    const request = createGatewayRequestMock((method) => {
      if (method === "projects.list") {
        return Promise.resolve({
          projects: [
            { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
          ],
        });
      }
      if (method === "taskSuggestions.accept") {
        if (++attempts === 1) {
          return Promise.reject(
            new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Checkout has no commits",
              details: { code: "TASK_WORKTREE_SOURCE_REQUIRED", cwd: suggestion.cwd },
            }),
          );
        }
        return Promise.resolve({ taskId: suggestion.id, key: "agent:main:recovered" });
      }
      return Promise.resolve({ suggestions: [suggestion] });
    });
    const { pane } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
      "taskSuggestions.accept",
      "projects.list",
    ]);
    pane.taskSuggestions = [suggestion];
    const container = document.createElement("div");
    const draw = () =>
      render(renderChatTaskSuggestionTray(pane.suggestionChatProps(true, false, false)), container);
    await pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
    await vi.waitFor(() => {
      draw();
      expect(container.querySelector(".task-suggestion__repository-choice")).not.toBeNull();
    });
    draw();
    expect(container.textContent).toContain(suggestion.prompt);
    expect(container.textContent).toContain("Checkout has no commits");
    const input = () =>
      container.querySelector<HTMLInputElement>(".task-suggestion__repository-path")!;
    expect(input().value).toBe(suggestion.cwd);
    container.querySelector<HTMLButtonElement>(".task-suggestion__repository-choice")!.click();
    draw();
    expect(input().value).toBe("/projects/app");
    expect(attempts).toBe(1);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")!
      .click();
    draw();
    expect(container.querySelector(".task-suggestion__repository-path")).toBeNull();
    expect(container.textContent).toContain(suggestion.prompt);
    container.querySelector<HTMLButtonElement>(".task-suggestion__retry")!.click();
    draw();
    expect(input().value).toBe("/projects/app");
    input().value = "relative/path";
    input().dispatchEvent(new Event("input"));
    draw();
    expect(container.querySelector<HTMLButtonElement>(".task-suggestion__retry")!.disabled).toBe(
      true,
    );
    input().value = "/projects/app";
    input().dispatchEvent(new Event("input"));
    draw();
    container.querySelector<HTMLButtonElement>(".task-suggestion__retry")!.click();
    await vi.waitFor(() =>
      expect(
        pane.suggestionChatProps(true, false, false).taskSuggestionAcceptance?.(suggestion.id)
          ?.phase,
      ).toBe("started"),
    );
    draw();
    expect(container.querySelector(".task-suggestion")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "taskSuggestions.accept")).toEqual([
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree", cwd: "/projects/app" }],
    ]);
    expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
  });

  it("does not populate a recovery chooser from a retired connection", async () => {
    const projects = createDeferred<{
      projects: Array<{ id: string; displayName: string; repoRoot: string; source: string }>;
    }>();
    const request = createGatewayRequestMock((method) =>
      method === "projects.list"
        ? projects.promise
        : Promise.reject(
            new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "No commits",
              details: { code: "TASK_WORKTREE_SOURCE_REQUIRED" },
            }),
          ),
    );
    const { pane } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
      "taskSuggestions.accept",
      "projects.list",
    ]);
    pane.taskSuggestions = [suggestion];
    await pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
    pane.connectionGeneration += 1;
    projects.resolve({
      projects: [
        { id: "stale", displayName: "Stale project", repoRoot: "/stale", source: "registered" },
      ],
    });
    await projects.promise;
    const outcome = pane
      .suggestionChatProps(true, false, false)
      .taskSuggestionAcceptance?.(suggestion.id);
    expect(outcome?.phase === "failed" && outcome.repository?.projects).toEqual([]);
  });

  it("keeps submitted content through reconnect and fences a late acceptance behind a same-task retry", async () => {
    const first = createDeferred<TaskSuggestionsAcceptResult>();
    const retry = createDeferred<TaskSuggestionsAcceptResult>();
    let attempts = 0;
    const request = createGatewayRequestMock((method) => {
      if (method === "agents.list") {
        return Promise.resolve({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
        } satisfies AgentsListResult);
      }
      return method === "taskSuggestions.accept"
        ? ++attempts === 1
          ? first.promise
          : retry.promise
        : Promise.resolve({ suggestions: [] });
    });
    const { pane, state } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.selfUser = { id: "operator-a", name: "Operator A" };
    state.loadAssistantIdentity = vi.fn(async () => {});
    pane.taskSuggestions = [suggestion];
    const snapshot = pane.context.gateway.snapshot;
    const pending = pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
    const container = document.createElement("div");
    const draw = (connected: boolean) =>
      render(
        renderChatTaskSuggestionTray(pane.suggestionChatProps(connected, false, false)),
        container,
      );

    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
    draw(false);
    expect(container.textContent).toContain(suggestion.prompt);
    expect(container.textContent).toContain("Delivery unconfirmed");
    expect(container.querySelector<HTMLButtonElement>(".task-suggestion__retry")?.disabled).toBe(
      true,
    );
    await pane.resolveTaskSuggestion(suggestion, "accept");
    expect(attempts).toBe(1);
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    await pane.refreshTaskSuggestions();
    draw(true);
    expect(container.textContent).toContain(suggestion.prompt);
    const retrying = pane.resolveTaskSuggestion(suggestion, "accept");
    first.resolve({ taskId: suggestion.id, key: "agent:main:stale" });
    await pending;
    draw(true);
    expect(container.querySelector(".task-suggestion")).toBeNull();
    retry.resolve({ taskId: suggestion.id, key: "agent:main:recovered-task" });
    await retrying;
    draw(true);
    expect(container.querySelector(".task-suggestion")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "taskSuggestions.accept")).toEqual([
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
    ]);
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
    draw(false);
    expect(container.querySelector(".task-suggestion")).toBeNull();

    pane.applyGatewaySnapshot({
      ...snapshot,
      selfUser: { id: "operator-b", name: "Operator B" },
    });
    draw(true);
    expect(container.textContent).not.toContain(suggestion.prompt);
    expect(pane.taskSuggestions).toEqual([]);
  });

  it.each([
    { resolved: false, result: undefined },
    { resolved: true, result: undefined },
    { resolved: false, result: { taskId: "other-task", key: "agent:main:task" } },
    { resolved: false, result: { taskId: suggestion.id, key: " " } },
  ])(
    "restores a failed or unconfirmed acceptance and retries the same task (%j)",
    async ({ resolved, result }) => {
      const first = createDeferred<TaskSuggestionsAcceptResult>();
      const retry = createDeferred<TaskSuggestionsAcceptResult>();
      let attempts = 0;
      const request = createGatewayRequestMock((method) => {
        if (method === "taskSuggestions.accept") {
          return ++attempts === 1 ? first.promise : retry.promise;
        }
        return Promise.resolve({ suggestions: [] });
      });
      const { pane, state } = createTestChatPane({
        client: createTestGatewayClient(request),
        sessions: createSessionCapabilityFixture(),
      });
      pane.taskSuggestions = [suggestion];
      const pending = pane.resolveTaskSuggestion(suggestion, "accept", "worktree");
      expect(pane.taskSuggestions).toEqual([]);
      if (resolved) {
        pane.handleTaskSuggestionEvent({
          action: "resolved",
          taskId: suggestion.id,
          resolution: "accepted",
        });
      }
      if (result) {
        first.resolve(result);
      } else {
        first.reject(new Error("Synthetic session creation failed"));
      }
      await pending;
      await pane.refreshTaskSuggestions();
      expect(pane.taskSuggestions).toEqual([suggestion]);
      const failure = state.lastError;
      expect(failure).toContain(result ? "Couldn't confirm" : "Synthetic session creation failed");
      expect(state.chatError).toBe(failure);
      const container = document.createElement("div");
      render(renderChatTaskSuggestionTray(pane.suggestionChatProps(true, false, false)), container);
      expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
      expect(container.textContent).toContain(suggestion.prompt);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        result ? "Couldn't confirm" : "Synthetic session creation failed",
      );
      expect(container.querySelector(".task-suggestion__retry")?.textContent).toContain("Retry");
      const retrying = pane.resolveTaskSuggestion(suggestion, "accept");
      expect(pane.taskSuggestions).toEqual([]);
      expect(state.lastError).toBe(failure);
      expect(state.chatError).toBe(failure);
      await pane.resolveTaskSuggestion(suggestion, "accept");
      expect(attempts).toBe(2);
      expect(request.mock.calls.filter(([method]) => method === "taskSuggestions.accept")).toEqual([
        ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
        ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
      ]);
      retry.resolve({ taskId: suggestion.id, key: "agent:main:task" });
      await retrying;
      expect(pane.taskSuggestions).toEqual([]);
      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    },
  );

  it.each([
    { field: "lastError", sameMessage: false, beforeRetry: false },
    { field: "chatError", sameMessage: false, beforeRetry: false },
    { field: "lastError", sameMessage: true, beforeRetry: true },
    { field: "chatError", sameMessage: true, beforeRetry: false },
    { field: "both", sameMessage: true, beforeRetry: false },
  ] as const)(
    "preserves a newer error when a task retry succeeds (%j)",
    async ({ field, sameMessage, beforeRetry }) => {
      const retry = createDeferred<TaskSuggestionsAcceptResult>();
      let attempts = 0;
      const request = createGatewayRequestMock((method) =>
        method === "taskSuggestions.accept"
          ? ++attempts === 1
            ? Promise.reject(new Error("Session creation failed"))
            : retry.promise
          : Promise.resolve({ suggestions: [] }),
      );
      const { pane, state } = createTestChatPane({
        client: createTestGatewayClient(request),
        sessions: createSessionCapabilityFixture(),
      });
      pane.taskSuggestions = [suggestion];
      await pane.resolveTaskSuggestion(suggestion, "accept");
      const message = sameMessage ? "Session creation failed" : "Chat send failed";
      const publishNewerError = () => {
        if (field === "both") {
          state.lastError = state.chatError = message;
        } else {
          state[field] = message;
        }
      };
      if (beforeRetry) {
        publishNewerError();
      }
      const pending = pane.resolveTaskSuggestion(suggestion, "accept");
      if (!beforeRetry) {
        publishNewerError();
      }
      retry.resolve({ taskId: suggestion.id, key: "agent:main:task" });
      await pending;
      expect(pane.taskSuggestions).toEqual([]);
      expect(state.lastError).toBe(field === "chatError" ? null : message);
      expect(state.chatError).toBe(field === "lastError" ? null : message);
    },
  );

  it("keeps another task's identical failure when the first task recovers", async () => {
    const retry = createDeferred<TaskSuggestionsAcceptResult>();
    let attempts = 0;
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.accept"
        ? ++attempts === 2
          ? retry.promise
          : Promise.reject(new Error("Session creation failed"))
        : Promise.resolve({ suggestions: [] }),
    );
    const { pane, state } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    const other = { ...suggestion, id: "task_other" };
    pane.taskSuggestions = [suggestion, other];
    await pane.resolveTaskSuggestion(suggestion, "accept");
    const pending = pane.resolveTaskSuggestion(suggestion, "accept");
    await pane.resolveTaskSuggestion(other, "accept");
    retry.resolve({ taskId: suggestion.id, key: "agent:main:task" });
    await pending;
    expect(pane.taskSuggestions).toEqual([other]);
    expect(state.lastError).toBe("Session creation failed");
    expect(state.chatError).toBe("Session creation failed");
  });

  it.each(["hello", "client", "unknown"] as const)(
    "retires submitted suggestion content when Hello changes the %s recovery owner",
    async (source) => {
      const accepted = createDeferred<TaskSuggestionsAcceptResult>();
      const request = createGatewayRequestMock((method) =>
        method === "taskSuggestions.accept"
          ? accepted.promise
          : Promise.resolve({ suggestions: [] }),
      );
      const client = createTestGatewayClient(request);
      let recoveryReady = source === "client";
      Object.defineProperties(client, {
        recoveryScope: { get: () => (source === "unknown" ? "" : "principal-a") },
        recoveryScopeReady: { get: () => recoveryReady },
      });
      const { pane } = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
      const snapshot = pane.context.gateway.snapshot;
      const hello = snapshot.hello!;
      snapshot.hello = {
        ...hello,
        auth: { ...hello.auth, recoveryScope: source === "hello" ? "principal-a" : undefined },
      };
      snapshot.selfUser = { id: "operator-a", name: "Operator A" };
      pane.taskSuggestions = [suggestion];
      const pending = pane.resolveTaskSuggestion(suggestion, "accept");
      const container = document.createElement("div");
      const draw = () =>
        render(
          renderChatTaskSuggestionTray(pane.suggestionChatProps(true, false, false)),
          container,
        );
      recoveryReady = false;
      pane.applyGatewaySnapshot({
        ...snapshot,
        hello: { ...hello, auth: { ...hello.auth, recoveryScope: "principal-a" } },
      });
      draw();
      expect(container.querySelector(".task-suggestion")).toBeNull();
      pane.applyGatewaySnapshot({
        ...snapshot,
        hello: { ...hello, auth: { ...hello.auth, recoveryScope: "principal-b" } },
      });
      draw();
      expect(container.textContent).not.toContain(suggestion.prompt);
      accepted.resolve({ taskId: suggestion.id, key: "agent:main:old-owner" });
      await pending;
      draw();
      expect(pane.taskSuggestions).toEqual([]);
      expect(container.querySelector(".task-suggestion__open")).toBeNull();
      expect(
        request.mock.calls.filter(([method]) => method === "taskSuggestions.accept"),
      ).toHaveLength(1);
    },
  );

  it.each(
    (["starting", "failed", "started"] as const).flatMap((phase) =>
      [true, false].map((initiallyKnown) => ({ phase, initiallyKnown })),
    ),
  )(
    "retires a $phase suggestion after physical session replacement (initially known: $initiallyKnown)",
    async ({ phase, initiallyKnown }) => {
      const accepted = createDeferred<TaskSuggestionsAcceptResult>();
      const request = createGatewayRequestMock((method) =>
        method === "taskSuggestions.accept"
          ? accepted.promise
          : Promise.resolve({ suggestions: [] }),
      );
      const { pane, state } = createTestChatPane({
        client: createTestGatewayClient(request),
        sessions: createSessionCapabilityFixture(),
      });
      state.currentSessionId = initiallyKnown ? "physical-original" : undefined;
      state.loadAssistantIdentity = vi.fn(async () => {});
      const navigate = vi.fn();
      pane.onPaneSessionChange = navigate;
      pane.taskSuggestions = [suggestion];
      const pending = pane.resolveTaskSuggestion(suggestion, "accept");
      if (phase === "failed") {
        accepted.reject(new Error("Acceptance response unavailable"));
        await pending;
      } else if (phase === "started") {
        accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });
        await pending;
      }
      const container = document.createElement("div");
      const draw = () => {
        const props = pane.suggestionChatProps(true, false, false);
        render(renderChatTaskSuggestionTray(props), container);
        return props;
      };
      draw();
      expect(Boolean(container.querySelector(".task-suggestion"))).toBe(phase === "failed");
      state.currentSessionId = "physical-original";
      const originalProps = draw();
      expect(Boolean(container.querySelector(".task-suggestion"))).toBe(phase === "failed");

      state.currentSessionId = "physical-replacement";
      draw();
      expect(container.textContent).not.toContain(suggestion.prompt);
      expect(container.querySelector(".task-suggestion__open")).toBeNull();
      expect(container.querySelector(".task-suggestion__retry")).toBeNull();
      pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot });
      await pane.refreshTaskSuggestions();
      expect(pane.taskSuggestions).toEqual([]);
      // Retained handlers cannot revive a retired operation after reconciliation removes it.
      originalProps.onAcceptTaskSuggestion?.(suggestion, "local");
      expect(navigate).not.toHaveBeenCalled();
      expect(
        request.mock.calls.filter(([method]) => method === "taskSuggestions.accept"),
      ).toHaveLength(1);
      if (phase === "starting") {
        accepted.resolve({ taskId: suggestion.id, key: "agent:main:late-task" });
        await pending;
      }
      state.currentSessionId = "physical-original";
      draw();
      expect(container.textContent).not.toContain(suggestion.prompt);
      expect(pane.taskSuggestions).toEqual([]);
    },
  );

  it.each(["accept", "list"] as const)(
    "drops a late %s response after a same-client reconnect",
    async (action) => {
      const response = createDeferred<TaskSuggestionsAcceptResult | TaskSuggestionsListResult>();
      const client = createTestGatewayClient(createGatewayRequestMock(() => response.promise));
      const { pane } = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
      pane.taskSuggestions = action === "accept" ? [suggestion] : [];
      const pending =
        action === "accept"
          ? pane.resolveTaskSuggestion(suggestion, "accept")
          : pane.refreshTaskSuggestions();
      pane.connectionGeneration += 1;
      response.resolve(
        action === "accept"
          ? { taskId: suggestion.id, key: "agent:main:stale" }
          : { suggestions: [suggestion] },
      );
      await pending;
      expect(pane.taskSuggestions).toEqual(action === "accept" ? [suggestion] : []);
    },
  );
});
