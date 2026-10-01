/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
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
  it("keeps dismissed cards hidden across pending and late list responses", async () => {
    const dismissed = createDeferred<{ taskId: string; dismissed: boolean }>();
    const listed = createDeferred<TaskSuggestionsListResult>();
    let dismissedOnServer = false;
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.dismiss"
        ? dismissed.promise
        : dismissedOnServer
          ? Promise.resolve({ suggestions: [] })
          : listed.promise,
    );
    const { pane } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.taskSuggestions = [suggestion];

    const oldList = pane.refreshTaskSuggestions();
    const pending = pane.dismissTaskSuggestion(suggestion);
    expect(pane.taskSuggestions).toEqual([]);
    await pane.dismissTaskSuggestion(suggestion);
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.dismiss"),
    ).toHaveLength(1);

    const pendingList = pane.refreshTaskSuggestions();
    dismissedOnServer = true;
    dismissed.resolve({ taskId: suggestion.id, dismissed: true });
    await pending;
    listed.resolve({ suggestions: [suggestion] });
    await Promise.all([oldList, pendingList]);
    expect(pane.taskSuggestions).toEqual([]);
  });

  it("restores a failed dismissal without losing newly arrived suggestions", async () => {
    const dismissed = createDeferred<never>();
    const next = { ...suggestion, id: "task_next", title: "Next task" };
    let suggestions = [suggestion];
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.dismiss" ? dismissed.promise : Promise.resolve({ suggestions }),
    );
    const { pane, state } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.taskSuggestions = [suggestion];

    const pending = pane.dismissTaskSuggestion(suggestion);
    expect(pane.taskSuggestions).toEqual([]);
    await pane.refreshTaskSuggestions();
    expect(pane.taskSuggestions).toEqual([]);
    suggestions = [suggestion, next];
    pane.taskSuggestions = [next];
    dismissed.reject(new Error("Dismissal unavailable"));
    await pending;

    expect(pane.taskSuggestions).toEqual([suggestion, next]);
    expect(state.chatError).toBe("Dismissal unavailable");
  });

  it("does not restore a resolved card when the dismiss response is lost", async () => {
    const dismissed = createDeferred<never>();
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.dismiss"
        ? dismissed.promise
        : Promise.resolve({ suggestions: [] }),
    );
    const { pane, state } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.taskSuggestions = [suggestion];
    const pending = pane.dismissTaskSuggestion(suggestion);
    pane.handleTaskSuggestionEvent({
      action: "resolved",
      taskId: suggestion.id,
      resolution: "dismissed",
    });
    dismissed.reject(new Error("Response lost"));
    await pending;

    expect(pane.taskSuggestions).toEqual([]);
    expect(state.chatError).toBeNull();
  });

  it.each(["session", "connection"])(
    "does not restore a dismissal in a newer %s",
    async (change) => {
      const dismissed = createDeferred<never>();
      const { pane, state } = createTestChatPane({
        client: createTestGatewayClient(createGatewayRequestMock(() => dismissed.promise)),
        sessions: createSessionCapabilityFixture(),
      });
      pane.taskSuggestions = [suggestion];
      const pending = pane.dismissTaskSuggestion(suggestion);
      if (change === "connection") {
        pane.connectionGeneration += 1;
      } else {
        state.sessionKey = "agent:main:other";
      }
      const next = { ...suggestion, id: "task_other", sessionKey: state.sessionKey };
      pane.taskSuggestions = [next];
      dismissed.reject(new Error("Old dismissal failed"));
      await pending;

      expect(pane.taskSuggestions).toEqual([next]);
      expect(state.chatError).toBeNull();
    },
  );

  it("reconciles a refused dismissal with the authoritative suggestion list", async () => {
    const request = createGatewayRequestMock((method) =>
      Promise.resolve(
        method === "taskSuggestions.dismiss"
          ? { taskId: suggestion.id, dismissed: false }
          : { suggestions: [suggestion] },
      ),
    );
    const { pane } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.taskSuggestions = [suggestion];
    await pane.dismissTaskSuggestion(suggestion);
    await vi.waitFor(() => expect(pane.taskSuggestions).toEqual([suggestion]));
  });

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
    const first = pane.dismissTaskSuggestion(suggestion);
    const second = pane.dismissTaskSuggestion(next);
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

  it("keeps accept ownership and selection when the resolved event arrives before the response", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const lateList = createDeferred<TaskSuggestionsListResult>();
    let holdList = false;
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.accept"
        ? accepted.promise
        : holdList
          ? lateList.promise
          : Promise.resolve({ suggestions: [] } satisfies TaskSuggestionsListResult),
    );
    const client = createTestGatewayClient(request);
    const sessions = createSessionCapabilityFixture();
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    pane.taskSuggestions = [suggestion];
    const container = document.createElement("div");
    const draw = () =>
      render(renderChatTaskSuggestionTray(pane.suggestionChatProps(true, false, false)), container);

    const pending = pane.acceptTaskSuggestion(suggestion);
    draw();
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    expect(container.textContent).toContain("Starting");
    pane.handleTaskSuggestionEvent({
      action: "resolved",
      taskId: suggestion.id,
      resolution: "accepted",
    });
    await pane.refreshTaskSuggestions();
    expect(pane.taskSuggestions).toEqual([suggestion]);
    draw();
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    expect(container.textContent).toContain(suggestion.prompt);
    expect(container.textContent).toContain("Starting");
    await pane.acceptTaskSuggestion(suggestion);
    expect(request).toHaveBeenCalledWith("taskSuggestions.accept", {
      taskId: suggestion.id,
      mode: "local",
    });
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.accept"),
    ).toHaveLength(1);
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    draw();
    expect(container.textContent).toContain("Task started");
    expect(container.textContent).toContain(suggestion.prompt);
    const open = container.querySelector<HTMLAnchorElement>(".task-suggestion__open");
    expect(open?.textContent).toContain("Open session");
    expect(open?.getAttribute("href")).toContain("task");
    await pane.acceptTaskSuggestion(suggestion);
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.accept"),
    ).toHaveLength(1);
    open?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(pane.paneId, "agent:main:task");
    holdList = true;
    const refresh = pane.refreshTaskSuggestions();
    await pane.dismissTaskSuggestion(suggestion);
    lateList.resolve({ suggestions: [suggestion] });
    await refresh;
    expect(pane.taskSuggestions).toEqual([]);
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.dismiss"),
    ).toHaveLength(0);
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
    await pane.acceptTaskSuggestion(suggestion, "worktree");
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
    expect(container.textContent).toContain("Task started");
    expect(container.textContent).toContain(suggestion.prompt);
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
    await pane.acceptTaskSuggestion(suggestion, "worktree");
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

  it("drops an accept response after a same-client reconnect", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn(() => accepted.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapabilityFixture();
    const { pane } = createTestChatPane({ client, sessions });
    pane.taskSuggestions = [suggestion];
    const pending = pane.acceptTaskSuggestion(suggestion);
    pane.connectionGeneration += 1;
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:stale" });

    await pending;
    expect(pane.taskSuggestions).toEqual([suggestion]);
  });

  it("keeps submitted content through reconnect and fences a late acceptance behind a same-task retry", async () => {
    const first = createDeferred<TaskSuggestionsAcceptResult>();
    const retry = createDeferred<TaskSuggestionsAcceptResult>();
    let attempts = 0;
    const request = createGatewayRequestMock((method) =>
      method === "taskSuggestions.accept"
        ? ++attempts === 1
          ? first.promise
          : retry.promise
        : Promise.resolve({ suggestions: [] }),
    );
    const { pane, state } = createTestChatPane({
      client: createTestGatewayClient(request),
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.selfUser = { id: "operator-a", name: "Operator A" };
    state.loadAssistantIdentity = vi.fn(async () => {});
    pane.taskSuggestions = [suggestion];
    const snapshot = pane.context.gateway.snapshot;
    const pending = pane.acceptTaskSuggestion(suggestion, "worktree");
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
    await pane.acceptTaskSuggestion(suggestion);
    expect(attempts).toBe(1);
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    await pane.refreshTaskSuggestions();
    draw(true);
    expect(container.textContent).toContain(suggestion.prompt);
    const retrying = pane.acceptTaskSuggestion(suggestion);
    first.resolve({ taskId: suggestion.id, key: "agent:main:stale" });
    await pending;
    draw(true);
    expect(container.textContent).toContain("Starting");
    expect(container.querySelector(".task-suggestion__open")).toBeNull();
    retry.resolve({ taskId: suggestion.id, key: "agent:main:recovered-task" });
    await retrying;
    draw(true);
    expect(container.textContent).toContain("Task started");
    expect(container.querySelector(".task-suggestion__open")?.getAttribute("href")).toContain(
      "recovered-task",
    );
    expect(pane.suggestionChatProps(true, false, false).onOpenTaskSuggestion).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "taskSuggestions.accept")).toEqual([
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
      ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
    ]);
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
    draw(false);
    expect(container.textContent).toContain("Task started");
    expect(container.textContent).toContain(suggestion.prompt);
    expect(container.querySelector(".task-suggestion__open")?.getAttribute("href")).toBeNull();
    pane.applyGatewaySnapshot({
      ...snapshot,
      selfUser: { id: "operator-b", name: "Operator B" },
    });
    draw(true);
    expect(container.textContent).not.toContain(suggestion.prompt);
    expect(pane.taskSuggestions).toEqual([]);
  });

  it.each([false, true])(
    "retains the prompt after acceptance fails and retries the same task (resolved: %s)",
    async (resolved) => {
      const first = createDeferred<TaskSuggestionsAcceptResult>();
      const retry = createDeferred<TaskSuggestionsAcceptResult>();
      let attempts = 0;
      const request = createGatewayRequestMock((method) => {
        if (method === "taskSuggestions.accept") {
          return ++attempts === 1 ? first.promise : retry.promise;
        }
        return Promise.resolve({ suggestions: [] });
      });
      const { pane } = createTestChatPane({
        client: createTestGatewayClient(request),
        sessions: createSessionCapabilityFixture(),
      });
      pane.taskSuggestions = [suggestion];
      const pending = pane.acceptTaskSuggestion(suggestion, "worktree");
      if (resolved) {
        pane.handleTaskSuggestionEvent({
          action: "resolved",
          taskId: suggestion.id,
          resolution: "accepted",
        });
      }
      first.reject(new Error("Acceptance response unavailable"));
      await pending;
      await pane.refreshTaskSuggestions();
      expect(pane.taskSuggestions).toEqual([suggestion]);
      const container = document.createElement("div");
      render(renderChatTaskSuggestionTray(pane.suggestionChatProps(true, false, false)), container);
      expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
      expect(container.textContent).toContain(suggestion.prompt);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Acceptance response unavailable",
      );
      expect(container.querySelector(".task-suggestion__retry")?.textContent).toContain("Retry");
      const retrying = pane.acceptTaskSuggestion(suggestion);
      await pane.acceptTaskSuggestion(suggestion);
      expect(attempts).toBe(2);
      expect(request.mock.calls.filter(([method]) => method === "taskSuggestions.accept")).toEqual([
        ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
        ["taskSuggestions.accept", { taskId: suggestion.id, mode: "worktree" }],
      ]);
      retry.resolve({ taskId: suggestion.id, key: "agent:main:task" });
      await retrying;
    },
  );

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
      const pending = pane.acceptTaskSuggestion(suggestion);
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
      expect(container.textContent).toContain(suggestion.prompt);
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
      const pending = pane.acceptTaskSuggestion(suggestion);
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
      expect(container.textContent).toContain(suggestion.prompt);
      state.currentSessionId = "physical-original";
      const originalProps = draw();
      expect(container.textContent).toContain(suggestion.prompt);

      state.currentSessionId = "physical-replacement";
      draw();
      expect(container.textContent).not.toContain(suggestion.prompt);
      expect(container.querySelector(".task-suggestion__open")).toBeNull();
      expect(container.querySelector(".task-suggestion__retry")).toBeNull();
      pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot });
      await pane.refreshTaskSuggestions();
      expect(pane.taskSuggestions).toEqual([]);
      // Retained handlers cannot revive a retired operation after reconciliation removes it.
      originalProps.onOpenTaskSuggestion?.(suggestion);
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

  it("drops a list response after a same-client reconnect", async () => {
    const listed = createDeferred<TaskSuggestionsListResult>();
    const client = {
      request: vi.fn(() => listed.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapabilityFixture();
    const { pane } = createTestChatPane({ client, sessions });

    const pending = pane.refreshTaskSuggestions();
    pane.connectionGeneration += 1;
    listed.resolve({ suggestions: [suggestion] });

    await pending;
    expect(pane.taskSuggestions).toEqual([]);
  });
});
