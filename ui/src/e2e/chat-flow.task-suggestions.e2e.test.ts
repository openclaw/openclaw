import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import type { TaskSuggestion } from "../../../packages/gateway-protocol/src/schema/task-suggestions.js";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { createControlUiMockBootstrapConfig } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import {
  newChatPage,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const startLabel = "Start in a new session";
const optionsLabel = "Choose where to start the task";
const visible = { state: "visible", timeout: 10_000 } as const;
const findButton = (root: Page | Locator, name: string) => root.getByRole("button", { name });
const taskCard = (page: Page, id: string) => page.locator(`.task-suggestion[data-task-id="${id}"]`);

function makeSuggestion(
  fields: Pick<TaskSuggestion, "id"> & Partial<TaskSuggestion>,
): TaskSuggestion {
  return {
    title: "Remove stale adapter",
    prompt: "Delete the stale adapter in src/example.ts and update tests.",
    tldr: "The adapter is unreachable and adds maintenance cost.",
    cwd: "/projects/example",
    sessionKey: "main",
    agentId: "main",
    createdAt: Date.now(),
    ...fields,
  };
}

const suggestionMethods = [
  "chat.metadata",
  "chat.startup",
  "taskSuggestions.list",
  "taskSuggestions.accept",
  "taskSuggestions.dismiss",
];

function installSuggestions(
  page: Page,
  suggestions: TaskSuggestion[],
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    featureMethods: suggestionMethods,
    ...options,
    methodResponses: { "taskSuggestions.list": { suggestions }, ...options.methodResponses },
  });
}

async function expectReadableButton(button: Locator) {
  const raw = await button.evaluate((element) => ({
    foreground: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  }));
  const colors = await button.page().evaluate(resolveRenderedColors, raw);
  const luminance = (color: RenderedColor) =>
    [color.red, color.green, color.blue]
      .map((value) => value / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const foreground = colors.foreground!;
  expect
    .soft(Math.min(foreground.red, foreground.green, foreground.blue))
    .toBeGreaterThanOrEqual(240);
  expect
    .soft((luminance(foreground) + 0.05) / (luminance(colors.background!) + 0.05))
    .toBeGreaterThanOrEqual(4.5);
}

suite.define(() => {
  it.each([
    { mode: "local", label: "Start in a new session", accent: "#da7756" },
    { mode: "worktree", label: "Start in a new worktree", accent: "#ffffff" },
    { mode: "session", label: "Start in this session", accent: "#ffffff" },
    { mode: "worktree", label: "Start in a new worktree", accent: "#00ff00" },
  ])("hides tasks and restores failures ($mode, $accent)", async ({ mode, label, accent }) => {
    const page = await newChatPage(suite, {
      ...createControlUiE2eContextOptions(),
      colorScheme: mode === "worktree" ? "dark" : "light",
    });
    const suggestion = makeSuggestion({ id: "task_123" });
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

    await page.route("**/control-ui-config.json", (route) =>
      route.fulfill({
        json: { ...createControlUiMockBootstrapConfig(), seamColor: accent },
      }),
    );

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("taskSuggestions.list");
    await gateway.emitGatewayEvent("task.suggestion", {
      action: "created",
      suggestion,
    });
    await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });

    const startButton = findButton(page, startLabel);
    await startButton.waitFor(visible);
    const card = taskCard(page, suggestion.id);
    const options = findButton(card, optionsLabel);
    expect(
      await startButton.evaluate((element) => getComputedStyle(element).borderTopRightRadius),
    ).toBe("0px");
    expect(await options.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe(
      "0px",
    );
    await options.click();
    await card.getByRole("menuitem", { name: "Start in a new worktree" }).waitFor();
    expect(await gateway.getRequests("taskSuggestions.accept")).toHaveLength(0);
    const triggerBox = await options.boundingBox();
    expect(triggerBox).not.toBeNull();
    const menuBox = await card.getByRole("menu").boundingBox();
    expect.soft(menuBox?.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
    for (const button of [startButton, options]) {
      await page.mouse.move(0, 0);
      await button.evaluate(finishElementAnimations);
      await expectReadableButton(button);
      await button.hover();
      await button.evaluate(finishElementAnimations);
      await expectReadableButton(button);
    }

    await page.keyboard.press("Escape");
    await expect
      .poll(() => options.evaluate((element) => element === document.activeElement))
      .toBe(true);
    expect(await findButton(card, "Copy prompt").isEnabled()).toBe(true);
    expect(await gateway.getRequests("environments.list")).toHaveLength(0);

    await page.getByText("Show instructions", { exact: true }).click();
    await page.getByText("/projects/example", { exact: true }).waitFor(visible);
    await page
      .getByText("Delete the stale adapter in src/example.ts and update tests.", {
        exact: true,
      })
      .waitFor(visible);
    const sourceUrl = page.url();
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    const draft = "Continue the current conversation.";
    await composer.fill(draft);
    await gateway.deferNext("taskSuggestions.accept");
    if (mode === "local") {
      await startButton.click();
    } else {
      await options.click();
      await card.getByRole("menuitem", { name: label, exact: true }).click();
    }
    await gateway.waitForRequest("taskSuggestions.accept");
    await card.waitFor({ state: "detached" });
    await gateway.setMethodResponse("taskSuggestions.list", { suggestions: [] });
    await gateway.emitGatewayEvent("task.suggestion", {
      action: "resolved",
      taskId: suggestion.id,
      resolution: "accepted",
    });
    expect(await card.count()).toBe(0);
    expect(page.url()).toBe(sourceUrl);
    expect(await composer.inputValue()).toBe(draft);

    if (mode !== "local") {
      await gateway.rejectDeferred("taskSuggestions.accept", {
        message: "Session creation unavailable",
      });
      await card.waitFor({ state: "visible" });
      await card.getByRole("alert").filter({ hasText: "Session creation unavailable" }).waitFor();
      expect(await card.getByText(suggestion.prompt, { exact: true }).isVisible()).toBe(true);

      await gateway.deferNext("taskSuggestions.accept");
      await card.getByRole("button", { name: "Retry", exact: true }).click();
      await waitForRequests(gateway, "taskSuggestions.accept", 2);
      await card.waitFor({ state: "detached" });
    }
    await gateway.resolveDeferred("taskSuggestions.accept", {
      taskId: suggestion.id,
      key: mode === "session" ? "main" : "agent:main:dashboard:suggested",
    });

    expect(await card.count()).toBe(0);
    expect(page.url()).toBe(sourceUrl);
    expect(await composer.inputValue()).toBe(draft);
    expect(
      (await gateway.getRequests("taskSuggestions.accept")).map((request) => request.params),
    ).toEqual(
      Array.from({ length: mode === "local" ? 1 : 2 }, () => ({ taskId: suggestion.id, mode })),
    );
  });

  it("dismisses suggested tasks immediately and restores a rejected dismissal without changing selection", async () => {
    const page = await newChatPage(suite);
    const suggestion = makeSuggestion({
      id: "task_dismiss",
      prompt: "Delete the stale adapter and update its tests.",
      tldr: "This follow-up is no longer needed.",
      createdAt: 2,
    });
    const nextSuggestion = {
      ...suggestion,
      id: "task_next",
      title: "Inspect remaining tests",
      prompt: "Inspect coverage of the remaining adapters.",
      tldr: "This follow-up remains useful.",
      createdAt: 1,
    };
    const gateway = await installSuggestions(page, [suggestion, nextSuggestion]);

    await page.goto(`${suite.server.baseUrl}chat`);
    const card = taskCard(page, suggestion.id);
    const nextCard = taskCard(page, nextSuggestion.id);
    await card.waitFor(visible);
    await gateway.deferNext("taskSuggestions.dismiss");
    await card.getByRole("button", { name: `Dismiss ${suggestion.title}` }).click();
    const dismissal = await gateway.waitForRequest("taskSuggestions.dismiss");
    expect(dismissal.params).toEqual({ taskId: suggestion.id });

    await expect.poll(() => card.count()).toBe(0);
    await nextCard.waitFor({ state: "visible" });
    expect(await findButton(nextCard, startLabel).isEnabled()).toBe(true);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("Continue working while the suggestion closes.");

    await gateway.deferNext("taskSuggestions.list");
    await gateway.emitGatewayEvent("task.suggestion", { action: "created", suggestion });
    await waitForRequests(gateway, "taskSuggestions.list", 2);
    const refreshedSuggestion = {
      ...nextSuggestion,
      tldr: "This follow-up remains available after refreshing the list.",
    };
    await gateway.resolveDeferred("taskSuggestions.list", {
      suggestions: [suggestion, refreshedSuggestion],
    });
    await nextCard.getByText(refreshedSuggestion.tldr, { exact: true }).waitFor();
    expect(await card.count()).toBe(0);

    const failure = "The suggestion could not be dismissed.";
    await gateway.rejectDeferred("taskSuggestions.dismiss", { message: failure });
    await page.getByText(failure, { exact: true }).first().waitFor();
    await expect.poll(() => card.count()).toBe(1);
    expect(await card.isVisible()).toBe(false);
    expect(await nextCard.isVisible()).toBe(true);
    expect(await composer.inputValue()).toBe("Continue working while the suggestion closes.");
    await nextCard.getByRole("button", { name: "Previous suggested task" }).click();
    await card.waitFor({ state: "visible" });
    expect(await findButton(card, startLabel).isEnabled()).toBe(true);
    expect(await gateway.getRequests("taskSuggestions.dismiss")).toHaveLength(1);
    expect(await gateway.getRequests("taskSuggestions.accept")).toHaveLength(0);
  });

  it("clears model-suggested follow-ups while switching sessions", async () => {
    const page = await newChatPage(suite);
    const gateway = await installSuggestions(
      page,
      [makeSuggestion({ id: "task_session_a", sessionKey: "agent:main:session-a" })],
      {
        methodResponses: { "sessions.list": chatSessionListResponse() },
        sessionKey: "agent:main:session-a",
      },
    );

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    const startButton = findButton(page, startLabel);
    await startButton.waitFor(visible);
    await gateway.deferNext("taskSuggestions.list");
    await page
      .locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
      )
      .click();
    await waitForRequests(gateway, "taskSuggestions.list", 2);

    await expect.poll(() => startButton.count()).toBe(0);
    await gateway.resolveDeferred("taskSuggestions.list", { suggestions: [] });
  });

  it("keeps copy available when only listing is advertised", async () => {
    const page = await newChatPage(suite);
    const gateway = await installSuggestions(page, [makeSuggestion({ id: "task_list_only" })], {
      featureMethods: ["chat.metadata", "chat.startup", "taskSuggestions.list"],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("taskSuggestions.list");
    const card = taskCard(page, "task_list_only");
    await card.waitFor(visible);
    expect(await findButton(card, startLabel).isDisabled()).toBe(true);
    expect(await findButton(card, optionsLabel).isDisabled()).toBe(true);
    expect(await findButton(card, "Copy prompt").isEnabled()).toBe(true);
  });

  it.each([
    { width: 1280, height: 720 },
    { width: 390, height: 720 },
    { width: 900, height: 500 },
  ])(
    "shows readable follow-up summaries and reachable actions at $width×$height",
    async ({ width, height }) => {
      const page = await newChatPage(suite, {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height, width },
      });
      const suggestions = Array.from({ length: 12 }, (_, index) =>
        makeSuggestion({
          id: `task_overflow_${index}`,
          title: `Follow-up ${index}`,
          prompt: "Inspect the related implementation and tests. ".repeat(12),
          tldr: "The attached tool fails in coordination mode even with all selectors omitted, while a classless fixed-lease CLI warmup succeeds. Make the adapter preserve omitted selectors so both entry points select the same default and the follow-up can run without extra configuration.",
          createdAt: Date.now() + index,
        }),
      );
      const gateway = await installSuggestions(page, suggestions);

      await page.goto(`${suite.server.baseUrl}chat`);
      const tray = page.locator(".task-suggestions");
      await tray.waitFor(visible);
      expect(await tray.locator(".task-suggestion:visible").count()).toBe(1);
      expect(await tray.getByText("1 / 12", { exact: true }).count()).toBe(1);
      await tray.getByRole("button", { name: "Next suggested task" }).click();
      expect(await tray.getByText("2 / 12", { exact: true }).count()).toBe(1);
      const summary = tray.locator(".task-suggestion:visible .task-suggestion__summary");

      expect(
        await summary.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
      ).toBe(true);

      expect(
        await summary.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);

      const verboseSuggestion = { ...suggestions[1]!, tldr: "W".repeat(1_024) };
      suggestions[1] = verboseSuggestion;
      await gateway.setMethodResponse("taskSuggestions.list", { suggestions });
      await gateway.emitGatewayEvent("task.suggestion", {
        action: "created",
        suggestion: verboseSuggestion,
      });
      await expect.poll(() => summary.textContent()).toBe(verboseSuggestion.tldr);
      expect(
        await summary.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await summary.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            const observer = new ResizeObserver(() => {
              observer.disconnect();
              resolve();
            });
            observer.observe(element);
          }),
      );
      const summaryScroll = await summary.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          reachesBottom:
            element.scrollTop > 0 &&
            element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
        };
      });
      expect(summaryScroll.reachesBottom, JSON.stringify(summaryScroll)).toBe(true);

      const card = tray.locator(".task-suggestion:visible");
      await card.getByText("Show instructions", { exact: true }).click();
      const start = card.getByRole("button", { name: "Start in a new session", exact: true });
      await expect
        .poll(() =>
          card.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const conversation = element
              .closest(".chat-main__conversation")!
              .getBoundingClientRect();
            const details = element
              .closest("openclaw-chat-pane")!
              .querySelector(".chat-details-toggle")!
              .getBoundingClientRect();
            const clearOfDetails =
              box.left >= details.right ||
              box.right <= details.left ||
              box.top >= details.bottom ||
              box.bottom <= details.top;
            return (
              clearOfDetails &&
              box.top >= conversation.top &&
              box.bottom <= conversation.bottom &&
              box.left >= conversation.left &&
              box.right <= conversation.right
            );
          }),
        )
        .toBe(true);

      for (const control of [findButton(card, "Copy prompt"), start]) {
        expect(
          await control.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
            );
          }),
        ).toBe(true);
      }
      await start.click({ trial: true });

      const composer = page.locator(".agent-chat__composer-shell");
      await composer.waitFor(visible);
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? height) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
    },
  );
});
