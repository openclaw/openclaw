import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  controlUiSessionPath,
  captureUiProof,
  installMockGateway,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { mode: "local", label: "Start in a new session" },
    { mode: "worktree", label: "Start in a new worktree" },
    { mode: "session", label: "Start in this session" },
  ])("starts a suggested task with $mode placement", async ({ mode, label }) => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      colorScheme: mode === "worktree" ? "dark" : "light",
    });
    const page = await context.newPage();
    const suggestion = {
      id: "task_123",
      title: "Remove stale adapter",
      prompt: "Delete the stale adapter in src/example.ts and update tests.",
      tldr: "The adapter is unreachable and adds maintenance cost.",
      cwd: "/projects/example",
      sessionKey: "main",
      agentId: "main",
      createdAt: Date.now(),
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["taskSuggestions.list"],
      featureCapabilities: [GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
        "environments.list",
      ],
      methodResponses: {
        "environments.list": { environments: [], profiles: [{ id: "build" }] },
        "taskSuggestions.list": { suggestions: [suggestion] },
        "taskSuggestions.accept": {
          taskId: "task_123",
          key: mode === "session" ? "main" : "agent:main:dashboard:suggested",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("taskSuggestions.list");
      await gateway.emitGatewayEvent("task.suggestion", {
        action: "created",
        suggestion,
      });
      await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });

      const startButton = page.getByRole("button", { name: "Start in a new session" });
      await startButton.waitFor({ state: "visible", timeout: 10_000 });
      const card = page.locator(`.task-suggestion[data-task-id="${suggestion.id}"]`);
      const options = card.getByRole("button", { name: "Choose where to start the task" });
      expect(
        await startButton.evaluate((element) => getComputedStyle(element).borderTopRightRadius),
      ).toBe("0px");
      expect(
        await options.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
      ).toBe("0px");
      await options.click();
      await card.getByRole("menuitem", { name: "Start in a new worktree" }).waitFor();
      expect(await gateway.getRequests("taskSuggestions.accept")).toHaveLength(0);
      await captureUiProof(suite, page, "task-suggestions", `${mode}-menu.png`);
      await page.keyboard.press("Escape");
      await expect
        .poll(() => options.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await card.getByRole("button", { name: "Copy prompt" }).isEnabled()).toBe(true);
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      await captureUiProof(suite, page, "task-suggestions", `${mode}-split-button.png`);
      await page.getByText("Show instructions", { exact: true }).click();
      await page
        .getByText("/projects/example", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByText("Delete the stale adapter in src/example.ts and update tests.", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 10_000 });
      const sourceUrl = page.url();
      await gateway.deferNext("taskSuggestions.accept");
      if (mode === "local") {
        await startButton.click();
      } else {
        await options.click();
        await card.getByRole("menuitem", { name: label, exact: true }).click();
      }
      await gateway.waitForRequest("taskSuggestions.accept");
      expect(await card.getByRole("button", { name: "Starting…", exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await options.isDisabled()).toBe(true);
      await gateway.resolveDeferred("taskSuggestions.accept", {
        taskId: suggestion.id,
        key: mode === "session" ? "main" : "agent:main:dashboard:suggested",
      });

      const acceptRequest = await gateway.waitForRequest("taskSuggestions.accept");
      expect(acceptRequest.params).toEqual({ taskId: "task_123", mode });
      if (mode === "session") {
        await card.waitFor({ state: "hidden" });
        expect(page.url()).toBe(sourceUrl);
      } else {
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath("agent:main:dashboard:suggested"));
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("clears model-suggested follow-ups while switching sessions", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
        "taskSuggestions.dismiss",
      ],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "taskSuggestions.list": {
          suggestions: [
            {
              id: "task_session_a",
              title: "Follow up from session A",
              prompt: "Complete the follow-up discovered in session A.",
              tldr: "This suggestion belongs only to session A.",
              cwd: "/projects/example",
              sessionKey: "agent:main:session-a",
              agentId: "main",
              createdAt: Date.now(),
            },
          ],
        },
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      const startButton = page.getByRole("button", { name: "Start in a new session" });
      await startButton.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.deferNext("taskSuggestions.list");
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await waitForRequests(gateway, "taskSuggestions.list", 2);

      await expect.poll(() => startButton.count()).toBe(0);
      await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps copy available when only listing is advertised", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "taskSuggestions.list"],
      methodResponses: {
        "taskSuggestions.list": {
          suggestions: [
            {
              id: "task_list_only",
              title: "Read-only follow-up",
              prompt: "Copy this suggestion without mutating it.",
              tldr: "Listing alone still exposes the client-local copy action.",
              cwd: "/projects/example",
              sessionKey: "main",
              agentId: "main",
              createdAt: Date.now(),
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("taskSuggestions.list");
      await expect
        .poll(() =>
          page
            .locator("openclaw-chat-pane")
            .evaluate(
              (pane) =>
                (pane as HTMLElement & { taskSuggestions?: unknown[] }).taskSuggestions?.length ??
                0,
            ),
        )
        .toBe(1);

      await page
        .locator(".agent-chat__composer-shell")
        .waitFor({ state: "visible", timeout: 10_000 });
      const card = page.locator('.task-suggestion[data-task-id="task_list_only"]');
      await card.waitFor({ state: "visible", timeout: 10_000 });
      expect(await card.getByRole("button", { name: "Start in a new session" }).isDisabled()).toBe(
        true,
      );
      expect(
        await card.getByRole("button", { name: "Choose where to start the task" }).isDisabled(),
      ).toBe(true);
      expect(await card.getByRole("button", { name: "Copy prompt" }).isEnabled()).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("stacks follow-up suggestions without obscuring the composer", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "taskSuggestions.list",
        "taskSuggestions.accept",
        "taskSuggestions.dismiss",
      ],
      methodResponses: {
        "taskSuggestions.list": {
          suggestions: Array.from({ length: 12 }, (_, index) => ({
            id: `task_overflow_${index}`,
            title: `Follow-up ${index}`,
            prompt: "Inspect the related implementation and tests. ".repeat(12),
            tldr: "This follow-up remains useful but must not hide the composer.",
            cwd: "/projects/example",
            sessionKey: "main",
            agentId: "main",
            createdAt: Date.now() + index,
          })),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const tray = page.locator(".task-suggestions");
      await tray.waitFor({ state: "visible", timeout: 10_000 });
      expect(await tray.locator(".task-suggestion:visible").count()).toBe(1);
      expect(await tray.getByText("1 / 12", { exact: true }).count()).toBe(1);
      await tray.getByRole("button", { name: "Next suggested task" }).click();
      expect(await tray.getByText("2 / 12", { exact: true }).count()).toBe(1);

      const composer = page.locator(".agent-chat__composer-shell");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? 720) + (box?.height ?? 0)).toBeLessThanOrEqual(720);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
