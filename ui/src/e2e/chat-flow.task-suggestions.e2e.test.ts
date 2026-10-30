import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { TaskSuggestion } from "../../../packages/gateway-protocol/src/schema/task-suggestions.js";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { createControlUiMockBootstrapConfig } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors } from "../test-helpers/rendered-colors.ts";
import {
  newChatPage,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const startLabel = "Start in a new session";
const optionsLabel = "Choose where to start the task";
const visible = { state: "visible", timeout: 10_000 } as const;
const findButton = (root: Page | Locator, name: string) => root.getByRole("button", { name });
const exactText = (root: Page | Locator, text: string) => root.getByText(text, { exact: true });
const taskCard = (page: Page, id: string) => page.locator(`.task-suggestion[data-task-id="${id}"]`);
type GatewayOptions = Parameters<typeof installMockGateway>[1];

function makeTask(fields: Pick<TaskSuggestion, "id"> & Partial<TaskSuggestion>): TaskSuggestion {
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

const listMethods = ["chat.metadata", "chat.startup", "taskSuggestions.list"];
const acceptMethods = [...listMethods, "taskSuggestions.accept"];

function installTasks(page: Page, suggestions: TaskSuggestion[], options: GatewayOptions = {}) {
  return installMockGateway(page, {
    featureMethods: [...acceptMethods, "taskSuggestions.dismiss"],
    ...options,
    methodResponses: { "taskSuggestions.list": { suggestions }, ...options.methodResponses },
  });
}

async function openTasks(
  suggestions: TaskSuggestion[],
  options: GatewayOptions = {},
  context?: Parameters<typeof newChatPage>[1],
) {
  const page = await newChatPage(suite, context);
  const gateway = await installTasks(page, suggestions, options);
  await page.goto(`${suite.server.baseUrl}chat`);
  return { page, gateway };
}

async function renderedFill(button: Locator) {
  await button.evaluate(finishElementAnimations);
  const raw = await button.evaluate((element) => ({
    foreground: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  }));
  return button.page().evaluate(resolveRenderedColors, raw);
}

// The start action shares Send's accent fill and ink, at rest and on hover.
async function expectSendFill(button: Locator, send: Locator) {
  const page = button.page();
  for (const hovered of [false, true]) {
    await page.mouse.move(0, 0);
    if (hovered) {
      await send.hover();
    }
    const expected = await renderedFill(send);
    await page.mouse.move(0, 0);
    if (hovered) {
      await button.hover();
    }
    expect.soft(await renderedFill(button)).toEqual(expected);
  }
}

suite.define(() => {
  it.each([
    { mode: "local", label: "Start in a new session", accent: "#da7756" },
    { mode: "worktree", label: "Start in a new worktree", accent: "#ffffff" },
    { mode: "session", label: "Start in this session", accent: "#ffffff" },
  ])(
    "starts tasks without replacing the current draft ($mode, $accent)",
    async ({ mode, label, accent }) => {
      const page = await newChatPage(suite, {
        ...createControlUiE2eContextOptions(),
        colorScheme: mode === "worktree" ? "dark" : "light",
      });
      const suggestion = makeTask({ id: "task_123" });
      const gateway = await installTasks(page, [suggestion], {
        deferredMethods: ["taskSuggestions.list"],
        featureCapabilities: [GATEWAY_SERVER_CAPS.TASK_SUGGESTIONS_ACCEPT_MODES],
        featureMethods: [...acceptMethods, "environments.list"],
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
      expect(
        await options.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
      ).toBe("0px");
      await options.click();
      await card.getByRole("menuitem", { name: "Start in a new worktree" }).waitFor();
      expect(await gateway.getRequests("taskSuggestions.accept")).toHaveLength(0);
      const triggerBox = await options.boundingBox();
      expect(triggerBox).not.toBeNull();
      // The row sits above the composer, so its menu opens upward into the transcript.
      const menuBox = await card.getByRole("menu").boundingBox();
      expect.soft((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(triggerBox!.y);

      await page.keyboard.press("Escape");
      await expect
        .poll(() => options.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);

      // Above the composer, not floating over the transcript.
      const footer = page.locator(".chat-footer__context");
      expect(
        await footer.locator(`.task-suggestion[data-task-id="${suggestion.id}"]`).count(),
      ).toBe(1);
      const toggle = card.locator(".task-suggestion__toggle");
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await exactText(page, suggestion.prompt).isVisible()).toBe(false);
      await toggle.click();
      await exactText(page, suggestion.tldr).waitFor(visible);
      await exactText(page, suggestion.cwd).waitFor(visible);
      await exactText(page, suggestion.prompt).waitFor(visible);
      expect(await findButton(card, "Copy prompt").isEnabled()).toBe(true);
      // Open, the start action sits in the footer, nearest the composer.
      expect(await card.locator('.task-suggestion__split[data-placement="foot"]').isVisible()).toBe(
        true,
      );
      const sourceUrl = page.url();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft = "Continue the current conversation.";
      const currentState = async () => [
        await card.count(),
        page.url(),
        await composer.inputValue(),
      ];
      await composer.fill(draft);
      const send = page.locator(".agent-chat__input").getByRole("button", { name: "Send message" });
      await expect.poll(() => send.isEnabled()).toBe(true);
      for (const button of [startButton, options]) {
        await expectSendFill(button, send);
      }
      await page.mouse.move(0, 0);
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
      expect(await currentState()).toEqual([0, sourceUrl, draft]);

      await gateway.resolveDeferred("taskSuggestions.accept", {
        taskId: suggestion.id,
        key: mode === "session" ? "main" : "agent:main:dashboard:suggested",
      });

      expect(await currentState()).toEqual([0, sourceUrl, draft]);
      const accepted = await gateway.getRequests("taskSuggestions.accept");
      expect(accepted.map(({ params }) => params)).toEqual([{ taskId: suggestion.id, mode }]);
    },
  );

  it("keeps copy available when only listing is advertised", async () => {
    const { page, gateway } = await openTasks([makeTask({ id: "task_list_only" })], {
      featureMethods: listMethods,
    });

    await gateway.waitForRequest("taskSuggestions.list");
    const card = taskCard(page, "task_list_only");
    await card.waitFor(visible);
    expect(await findButton(card, startLabel).isDisabled()).toBe(true);
    expect(await findButton(card, optionsLabel).isDisabled()).toBe(true);
    // Copy lives beside the prompt it copies.
    await card.locator(".task-suggestion__toggle").click();
    expect(await findButton(card, "Copy prompt").isEnabled()).toBe(true);
  });

  it.each([
    { width: 1280, height: 720 },
    { width: 390, height: 720 },
    { width: 900, height: 500 },
  ])(
    "shows readable follow-up summaries and reachable actions at $width×$height",
    async ({ width, height }) => {
      const suggestions = Array.from({ length: 12 }, (_, index) =>
        makeTask({
          id: `task_overflow_${index}`,
          title: `Follow-up ${index}`,
          prompt: "Inspect the related implementation and tests. ".repeat(12),
          tldr: "The attached tool fails in coordination mode even with all selectors omitted, while a classless fixed-lease CLI warmup succeeds. Make the adapter preserve omitted selectors so both entry points select the same default and the follow-up can run without extra configuration.",
          createdAt: Date.now() + index,
        }),
      );
      const { page, gateway } = await openTasks(
        suggestions,
        {},
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height, width },
        },
      );
      const tray = page.locator(".task-suggestions");
      await tray.waitFor(visible);
      expect(await tray.locator(".task-suggestion:visible").count()).toBe(1);
      await tray.locator(".task-suggestion:visible .task-suggestion__toggle").click();
      expect(await exactText(tray, "1/12").count()).toBe(1);
      await tray.getByRole("button", { name: "Next suggested task" }).click();
      expect(await exactText(tray, "2/12").count()).toBe(1);
      const summary = tray.locator(".task-suggestion:visible .task-suggestion__summary");

      expect(
        await summary.evaluate((element) => ({
          vertical: element.scrollHeight <= element.clientHeight + 1,
          horizontal: element.scrollWidth <= element.clientWidth + 1,
        })),
      ).toEqual({ vertical: true, horizontal: true });

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
      // Verbose output stays reachable inside the bounded details region.
      const detailsRegion = tray.locator(".task-suggestion:visible .task-suggestion__details");
      const summaryScroll = await detailsRegion.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return (
          element.scrollTop > 0 &&
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1
        );
      });
      expect(summaryScroll).toBe(true);

      const card = tray.locator(".task-suggestion:visible");
      const start = card.getByRole("button", { name: startLabel, exact: true });
      const hasClearance = () =>
        card.evaluate((element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          const area = element.closest(".chat-main__conversation")!.getBoundingClientRect();
          const pane = element.closest("openclaw-chat-pane")!;
          const details = pane.querySelector(".chat-details-toggle")!.getBoundingClientRect();
          return (
            top >= area.top &&
            bottom <= area.bottom &&
            left >= area.left &&
            right <= area.right &&
            (left >= details.right ||
              right <= details.left ||
              top >= details.bottom ||
              bottom <= details.top)
          );
        });
      await expect.poll(hasClearance).toBe(true);

      // Playwright's trial click proves each control is visible, stable and receives the pointer.
      for (const control of [findButton(card, "Copy prompt"), start]) {
        await control.click({ trial: true });
      }

      const composer = page.locator(".agent-chat__composer-shell");
      await composer.waitFor(visible);
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? height) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
    },
  );
});
