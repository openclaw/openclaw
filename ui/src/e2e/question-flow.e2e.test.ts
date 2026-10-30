import type { Question, QuestionResolveResult } from "@openclaw/gateway-protocol";
import type { BrowserContext, Locator, Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import type { SessionsListResult } from "../api/types.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { chatThreadDistanceFromBottom, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { defineQuestionFooterTests } from "./question-footer.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Gateway question flow",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const composerSelector = ".agent-chat__composer-combobox textarea";
const tooltipSelector = "openclaw-tooltip .tooltip-surface[popover]:popover-open";
const mainSessionKey = "agent:main:main";
const questionSessionKey = "agent:main:question-proof";

let context: BrowserContext | undefined;
function questionRecord(id: string, question: Partial<Question> | Question[] = {}) {
  const createdAtMs = Date.now();
  return {
    id,
    questions: Array.isArray(question)
      ? question
      : [
          {
            questionId: "deploy_target",
            header: "Deploy",
            question: "Where should I deploy?",
            options: [{ label: "Staging" }, { label: "Production" }],
            ...question,
          },
        ],
    agentId: "main",
    sessionKey: questionSessionKey,
    createdAtMs,
    expiresAtMs: createdAtMs + 15 * 60_000,
    status: "pending" as const,
  };
}

async function expectResolution(gateway: MockGatewayControls, params: unknown, after = 0) {
  expect((await gateway.waitForRequest("question.resolve", { after })).params).toEqual(params);
}

async function expectSecretInput(input: Locator, type: string, value: string) {
  expect([await input.getAttribute("type"), await input.inputValue()]).toEqual([type, value]);
}

async function newPage(viewport = { height: 900, width: 1440 }, hasTouch = false) {
  context = await suite.browser.newContext({
    hasTouch,
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
  return context.newPage();
}

function secretStoreQuestion(id: string) {
  return questionRecord(id, {
    questionId: "api_key",
    header: "API key",
    question: "Provide the deployment API key",
    options: [],
    isSecret: true,
    secretStore: {
      name: "DEPLOY_API_KEY",
      kind: "secret",
      allowedHosts: ["api.example.test"],
      reason: "Publish the release artifacts.",
    },
    secretStoreExisting: {
      updatedAtMs: Date.now() - 60_000,
      updatedBy: "release-operator",
    },
  });
}

function storedSecretAnswer(): QuestionResolveResult {
  return { status: "answered", answers: { answers: { api_key: ["stored"] } } };
}

function historyMessages() {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text:
          index === 11
            ? "I have the release context ready. I only need your deployment choice."
            : `Release preparation note ${index + 1}: deterministic transcript content for the question panel proof.`,
      },
    ],
    timestamp: 1_750_000_000_000 + index * 1_000,
  }));
}

async function openQuestionPage(viewport = { height: 900, width: 1440 }, hasTouch = false) {
  const page = await newPage(viewport, hasTouch);
  const gateway = await installMockGateway(page, {
    featureMethods: [
      "chat.abort",
      "chat.metadata",
      "chat.startup",
      "question.get",
      "question.list",
      "question.resolve",
      "sessions.create",
      "sessions.patch",
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    ],
    historyMessages: historyMessages(),
    methodResponses: {
      "question.list": { questions: [] },
      [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      "sessions.list": {
        ts: Date.now(),
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
        sessions: (
          [
            [mainSessionKey, "Home", -1_000],
            [questionSessionKey, "Question proof", 0],
          ] as const
        ).map(([key, label, offset]) => ({
          key,
          label,
          kind: "direct" as const,
          updatedAt: Date.now() + offset,
        })),
      } satisfies SessionsListResult,
    },
    // The handshake must advertise the genuine canonical main; the question
    // lives in its own existing thread so the real sidebar can render its row.
    sessionKey: mainSessionKey,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, questionSessionKey));
  const subscription = await gateway.waitForRequest("sessions.messages.subscribe");
  expect(subscription.params).toEqual(expect.objectContaining({ key: questionSessionKey }));
  const compactMobileViewport =
    viewport.width <= 768 ||
    (viewport.width <= 932 && viewport.height <= 500 && viewport.width > viewport.height);
  await page
    .locator(`[data-session-key="${questionSessionKey}"]`)
    .first()
    .waitFor({ state: compactMobileViewport ? "attached" : "visible" });
  // The mounted chat and sidebar share one authoritative question hydration.
  await expect.poll(async () => (await gateway.getRequests("question.list")).length).toBe(1);
  return { gateway, page };
}

const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const expectCount = async (locator: Locator, count: number) =>
  expect.poll(() => locator.count()).toBe(count);
const expectFocused = async (locator: Locator) =>
  expect.poll(() => locator.evaluate((element) => document.activeElement === element)).toBe(true);

async function expectSecretNotEchoed(page: Page, secret: string, markup = false) {
  expect(await page.locator("body").textContent()).not.toContain(secret);
  if (markup) {
    expect(await page.locator("body").evaluate((element) => element.innerHTML)).not.toContain(
      secret,
    );
  }
}

function panelFor(page: Page, prompt: string) {
  return page.locator("openclaw-chat-question-panel").filter({ hasText: prompt });
}

async function showQuestion(
  page: Page,
  gateway: MockGatewayControls,
  request: ReturnType<typeof questionRecord>,
) {
  await gateway.emitGatewayEvent("question.requested", request);
  const panel = panelFor(page, request.questions[0]!.question);
  await panel.waitFor();
  return panel;
}

async function openExternalStep(page: Page, activate: () => Promise<void>) {
  const popupPromise = page.waitForEvent("popup");
  await activate();
  const popup = await popupPromise;
  await popup.getByRole("heading", { name: "Controlled sign-in page" }).waitFor();
  return popup;
}

async function expectQuestionAttention(page: Page, preview: string | null): Promise<void> {
  const present = preview !== null;
  const session = page.locator(`[data-session-key="${questionSessionKey}"]`).first();
  const questionAttention = session.locator('[data-session-attention="question"]');
  await expectCount(questionAttention, present ? 1 : 0);
  if (present) {
    await expect
      .poll(() =>
        questionAttention.evaluate(
          (element) =>
            element
              .closest("openclaw-tooltip")
              ?.querySelector(".sidebar-session-attention-tooltip__preview")?.textContent,
        ),
      )
      .toBe(preview);
    await expectCount(session.locator(".sidebar-recent-session__subtitle"), 0);
  }
}

function scrollRegressionQuestion(id: string, prompt: string) {
  return questionRecord(id, {
    questionId: "release_strategy",
    header: "Strategy",
    question: prompt,
    options: Array.from({ length: 4 }, (_, index) => ({
      label: `Release strategy ${index + 1}`,
      description: `Deterministic option ${index + 1} makes the rendered panel exceed the near-bottom threshold after layout, proving resize reconciliation follows explicit user intent instead of stale geometry.`,
    })),
    isOther: true,
  });
}

suite.define(() => {
  afterEach(async () => {
    await context?.close().catch(() => {});
    context = undefined;
  });

  it("reveals sidebar attention on touch without navigating or closing the drawer", async () => {
    const { gateway, page } = await openQuestionPage({ width: 390, height: 844 }, true);
    const request = questionRecord("sidebar-touch-question", { isOther: false });

    await gateway.emitGatewayEvent("question.requested", request);
    await navigationDrawerToggle(page).tap();
    await expectQuestionAttention(page, request.questions[0]!.question);
    // The drawer's initial focus move must finish before opening the tooltip.
    await page.locator(".shell-nav:focus, .shell-nav :focus").waitFor();
    const row = page.locator(`[data-session-key="${questionSessionKey}"]`).first();
    const shell = page.locator(".shell");
    const attention = row.locator('[data-session-attention="question"]');
    const tooltip = row.locator(tooltipSelector);
    const route = page.url();

    await attention.tap();
    await expectCount(tooltip, 1);
    expect(await shell.getAttribute("class")).toContain("shell--nav-drawer-open");
    expect(page.url()).toBe(route);
    expect(await row.getByText(request.questions[0]!.question, { exact: true }).isVisible()).toBe(
      true,
    );
    expect(await gateway.getRequests("question.resolve")).toHaveLength(0);

    await attention.tap();
    await expectCount(tooltip, 0);
    expect(await shell.getAttribute("class")).toContain("shell--nav-drawer-open");
    await attention.tap();
    await expectCount(tooltip, 1);
    await page.keyboard.press("Escape");
    await expectCount(tooltip, 0);
    expect(await shell.getAttribute("class")).toContain("shell--nav-drawer-open");

    await row.locator(".sidebar-recent-session__link").tap();
    await expect.poll(() => shell.getAttribute("class")).not.toContain("shell--nav-drawer-open");
  });

  it("opens an external question step without answering until completion is submitted", async () => {
    const { gateway, page } = await openQuestionPage();
    const url = "https://chatgpt.com/apps/github/connector_question_proof";
    const prompt = "Sign in to GitHub on ChatGPT to use it in Codex.";
    await page.context().route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Controlled sign-in page</h1><p>Browser navigation proof; no account sign-in.</p>",
      }),
    );
    const request = questionRecord("question-external-step", {
      questionId: "continue",
      header: "Continue",
      question: prompt,
      url,
      options: [{ label: "I've completed this step" }, { label: "Decline" }],
      isOther: false,
    });

    const panel = await showQuestion(page, gateway, request);
    const link = panel.getByRole("link", { name: "Open link", exact: true });
    await expectCount(link, 1);
    expect(await link.getAttribute("href")).toBe(url);

    const popup = await openExternalStep(page, () => link.click());
    expect(popup.url()).toBe(url);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
    await panel.waitFor();
    await expectQuestionAttention(page, request.questions[0]!.question);
    expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
    expect(await button(panel, "Submit").isDisabled()).toBe(true);

    await panel.getByRole("radio", { name: /I've completed this step/ }).click();
    // Opening the link with Enter must not trigger the panel's Enter-to-submit shortcut.
    const keyboardPopup = await openExternalStep(page, () => link.press("Enter"));
    await keyboardPopup.close();
    await panel.waitFor();
    expect(await gateway.getRequests("question.resolve")).toHaveLength(0);

    const answers = { answers: { continue: ["I've completed this step"] } };
    await gateway.setMethodResponse("question.resolve", {
      status: "answered",
      answers,
    } satisfies QuestionResolveResult);
    await button(panel, "Submit").click();
    await expectResolution(gateway, { id: request.id, answers });
    expect(await gateway.getRequests("question.resolve")).toHaveLength(1);
    await expectCount(panel, 0);
    await expectQuestionAttention(page, null);
  });

  it.each([false, true])(
    "reconciles question footer layout with explicit backscroll: %s",
    async (backscroll) => {
      const { gateway, page } = await openQuestionPage();
      const thread = page.locator(".chat-thread");
      const latest = page.getByRole("button", { name: "Scroll to latest" });
      const distance = () =>
        expect.poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 });
      await waitForChatScrollIdle(page);
      let readingScrollTop = 0;
      if (backscroll) {
        await thread.hover();
        await page.mouse.wheel(0, -600);
        await distance().toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
        await latest.waitFor({ state: "visible", timeout: 10_000 });
        await waitForChatScrollIdle(page);
        readingScrollTop = await thread.evaluate((element) => element.scrollTop);
      } else {
        await distance().toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      }
      const request = scrollRegressionQuestion(
        "question-scroll",
        "Which detailed release strategy should I use?",
      );
      const panel = await showQuestion(page, gateway, request);
      await waitForChatScrollIdle(page);
      if (backscroll) {
        await expect
          .poll(
            async () =>
              Math.abs((await thread.evaluate((element) => element.scrollTop)) - readingScrollTop),
            { timeout: 10_000 },
          )
          .toBeLessThanOrEqual(2);
        await latest.waitFor({ state: "visible", timeout: 10_000 });
        await expect
          .poll(async () => {
            const arrowBox = await latest.boundingBox();
            const panelBox = await panel.boundingBox();
            return Boolean(arrowBox && panelBox && arrowBox.y + arrowBox.height <= panelBox.y);
          })
          .toBe(true);
      } else {
        await distance().toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
        await expect
          .poll(async () => {
            const panelBox = await panel.boundingBox();
            const conversationBox = await page.locator(".chat-main__conversation").boundingBox();
            return Boolean(
              panelBox &&
              conversationBox &&
              panelBox.y >= conversationBox.y - 1 &&
              panelBox.y + panelBox.height <= conversationBox.y + conversationBox.height + 1,
            );
          })
          .toBe(true);
        await expectCount(latest, 0);
      }
    },
  );

  defineQuestionFooterTests({
    openQuestionPage,
    questionRecord,
    questionSessionKey,
  });

  it("restores the composer without a resolution event and retains later pending-question drafts", async () => {
    const { gateway, page } = await openQuestionPage();
    const composer = page.locator(composerSelector);
    await composer.fill("Keep this release note draft");
    const request = questionRecord("question-deploy-target", {
      options: [{ label: "Staging (Recommended)" }, { label: "Production" }],
      isOther: true,
    });

    const panel = await showQuestion(page, gateway, request);
    await expectQuestionAttention(page, request.questions[0]!.question);
    await expectCount(page.locator(".chat-thread openclaw-chat-question-panel"), 0);
    await expectCount(panel.getByText("1/1", { exact: true }), 1);
    await expectCount(panel.getByPlaceholder("Type your own answer here"), 1);
    await expectCount(page.locator(".agent-chat__input"), 0);
    await expectCount(page.locator(".agent-chat__composer-footer"), 0);
    await expectFocused(panel.locator(".chat-question-panel"));

    await expect
      .poll(async () => {
        const panelBox = await panel.boundingBox();
        const shellBox = await page.locator(".agent-chat__composer-shell").boundingBox();
        if (!panelBox || !shellBox) {
          return null;
        }
        return {
          left: Math.round(panelBox.x - shellBox.x),
          width: Math.round(panelBox.width - shellBox.width),
        };
      })
      .toEqual({ left: 0, width: 0 });
    const attention = page.locator(
      `[data-session-key="${questionSessionKey}"] [data-session-attention="question"]`,
    );
    await attention.hover();
    await expectCount(page.locator(tooltipSelector), 1);
    await page.mouse.move(400, 50);
    await expectCount(page.locator(tooltipSelector), 0);
    await attention.focus();
    await expectCount(page.locator(tooltipSelector), 1);
    await expectCount(page.locator('.session-progress-hovercard[data-open="true"]'), 0);

    await panel.locator(".chat-question-panel__collapse").click();
    await composer.waitFor();
    await expect.poll(() => composer.inputValue()).toBe("Keep this release note draft");
    await expectFocused(composer);
    await page.locator(".chat-question-panel__collapsed-button").click();
    await expectCount(page.locator(".agent-chat__input"), 0);
    await expectFocused(panel.locator(".chat-question-panel"));

    const answers = { answers: { deploy_target: ["Staging (Recommended)"] } };
    await gateway.setMethodResponse("question.resolve", {
      status: "answered",
      answers,
    } satisfies QuestionResolveResult);
    await panel.getByRole("radio", { name: /Staging \(Recommended\)/ }).click();
    await button(panel, "Submit").click();
    await expectResolution(gateway, { id: request.id, answers });

    await expectCount(panel, 0);
    await expectQuestionAttention(page, null);
    const summary = page.locator(".chat-question-summary").filter({ hasText: "Deploy:" });
    await summary.waitFor();
    await expectCount(summary.getByText("Staging (Recommended)", { exact: true }), 1);
    await composer.waitFor();
    await expect.poll(() => composer.inputValue()).toBe("Keep this release note draft");
    await expectFocused(composer);
    await summary.scrollIntoViewIfNeeded();
    expect(
      await summary.getByText(request.questions[0]!.question, { exact: true }).isVisible(),
    ).toBe(true);

    const first = questionRecord("question-a-format", {
      questionId: "format",
      header: "Format",
      question: "Which format should I use?",
      options: [{ label: "Compact" }, { label: "Detailed" }],
      isOther: true,
    });

    const second = questionRecord("question-b-audience", {
      questionId: "audience",
      header: "Audience",
      question: "Who should read it?",
      options: [{ label: "Engineers" }, { label: "Everyone" }],
      isOther: true,
    });

    await gateway.emitGatewayEvent("question.requested", first);
    await gateway.emitGatewayEvent("question.requested", second);
    const pendingPanel = page.locator("openclaw-chat-question-panel");
    await pendingPanel.getByRole("textbox", { name: "Your own answer for Format" }).fill("Compact");
    await button(pendingPanel, "Next").click();
    await pendingPanel.getByText("Who should read it?", { exact: true }).waitFor();
    await button(pendingPanel, "Previous").click();
    await pendingPanel.getByText("Which format should I use?", { exact: true }).waitFor();
    expect(
      await pendingPanel.getByRole("textbox", { name: "Your own answer for Format" }).inputValue(),
    ).toBe("Compact");
    expect(
      await pendingPanel.getByRole("radio", { name: /Compact/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("preserves secret keyboard custody and retries rejected hosts without echoing the value", async () => {
    const { gateway, page } = await openQuestionPage();
    const request = secretStoreQuestion("question-store-secret-success");
    const fakeSecret = "fake-secret-never-use-browser-proof-123";
    const validationMessage = "Allowed hosts must be valid hostnames.";
    await gateway.setMethodResponse("question.resolve", {
      __mockError: { code: "INVALID_REQUEST", message: validationMessage },
    });
    const panel = await showQuestion(page, gateway, request);
    await expectCount(panel.getByText("Requested by main", { exact: false }), 1);
    await expectCount(panel.getByText("Publish the release artifacts."), 1);
    await expectCount(panel.getByText("Replaces DEPLOY_API_KEY", { exact: false }), 1);
    const secretInput = panel.getByLabel("API key", { exact: true });
    await expectCount(secretInput, 1);
    expect(await secretInput.getAttribute("type")).toBe("password");
    expect(await secretInput.getAttribute("autocomplete")).toBe("off");
    expect(await secretInput.getAttribute("placeholder")).toBe("DEPLOY_API_KEY");
    await expectCount(panel.locator('[role="radiogroup"]'), 0);
    const hostsInput = panel.locator(".chat-question-panel__hosts");
    expect(await hostsInput.inputValue()).toBe("api.example.test");

    await secretInput.fill(fakeSecret);
    await hostsInput.fill("api.example.test, uploads.example.test extra.example.test");
    await expectSecretNotEchoed(page, fakeSecret, true);

    await secretInput.focus();
    await page.keyboard.press("Tab");
    const reveal = button(panel, "Show secret");
    await expectFocused(reveal);
    await page.keyboard.press("Enter");
    await expectSecretInput(secretInput, "text", fakeSecret);
    const hide = button(panel, "Hide secret");
    expect(await hide.getAttribute("aria-pressed")).toBe("true");
    expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
    await page.keyboard.press("Space");
    await expectSecretInput(secretInput, "password", fakeSecret);
    expect(await gateway.getRequests("question.resolve")).toHaveLength(0);

    await button(panel, "Submit").click();
    await gateway.waitForRequest("question.resolve");
    await panel.getByText(validationMessage, { exact: false }).waitFor();
    await expect.poll(() => secretInput.isEnabled()).toBe(true);
    expect(await secretInput.inputValue()).toBe(fakeSecret);
    await expectSecretNotEchoed(page, fakeSecret);

    await gateway.setMethodResponse("question.resolve", storedSecretAnswer());
    await hostsInput.fill("corrected.example.test, uploads.example.test extra.example.test");
    const previousRequestCount = (await gateway.getRequests("question.resolve")).length;
    await button(panel, "Submit").click();
    await expectResolution(
      gateway,
      {
        id: request.id,
        answers: { answers: { api_key: [fakeSecret] } },
        secretStoreAllowedHosts: [
          "corrected.example.test",
          "uploads.example.test",
          "extra.example.test",
        ],
      },
      previousRequestCount,
    );
    await expectCount(panel, 0);
    const summary = page.locator(".chat-question-summary").filter({ hasText: "API key:" });
    await summary.waitFor();
    await expectCount(summary.getByText("Answered", { exact: true }), 1);
    expect(await summary.textContent()).not.toContain("stored");
    await expectSecretNotEchoed(page, fakeSecret);
  });

  it("loads a mounted /ask document and resolves its secret through the shared question card", async () => {
    const page = await newPage();
    const request = secretStoreQuestion("question-store-secret-deep-link");
    const fakeSecret = "fake-secret-never-use-deep-link-proof-789";
    const gateway = await installMockGateway(page, {
      basePath: "/operator",
      featureMethods: ["question.get", "question.resolve"],
      methodResponses: {
        "question.get": { question: request },
        "question.resolve": storedSecretAnswer(),
      },
    });
    const documentUrl = new URL(
      `operator/ask/${encodeURIComponent(request.id)}`,
      suite.server.baseUrl,
    );
    await page.goto(documentUrl.toString());
    const getRequest = await gateway.waitForRequest("question.get");
    expect(getRequest.params).toEqual({ id: request.id });

    const document = page.locator("openclaw-question-page");
    await document.waitFor();
    expect(await page.locator("openclaw-app-shell, openclaw-app-sidebar").count()).toBe(0);
    const panel = document.locator("openclaw-chat-question-panel");
    await panel.waitFor();
    expect(await document.getByRole("heading", { level: 1 }).textContent()).toContain(
      "Waiting for your answer",
    );
    expect(await page.title()).toBe("Waiting for your answer — OpenClaw");
    const secretInput = panel.getByLabel("API key", { exact: true });
    expect(await secretInput.getAttribute("type")).toBe("password");
    await secretInput.fill(fakeSecret);
    await expectSecretNotEchoed(page, fakeSecret, true);
    await button(panel, "Show secret").click();
    await expectSecretInput(secretInput, "text", fakeSecret);
    await button(panel, "Submit").click();

    await expectResolution(gateway, {
      id: request.id,
      answers: { answers: { api_key: [fakeSecret] } },
      secretStoreAllowedHosts: ["api.example.test"],
    });
    const outcomeHeading = document.getByRole("heading", { name: "Answered", exact: true });
    await outcomeHeading.waitFor();
    await expectFocused(outcomeHeading);
    expect(await page.title()).toBe("Answered — OpenClaw");
    expect(await document.textContent()).not.toContain(fakeSecret);
    expect(await document.textContent()).not.toContain("stored");
    expect(new URL(page.url()).pathname).toBe(`/operator/ask/${request.id}`);
  });

  it.each([
    ["answered", false],
    ["answered", true],
    ["cancelled", true],
  ] as const)(
    "reconciles %s across panes (submitting pane closed: %s) without a resolution event",
    async (status, closeSubmittingPane) => {
      const { gateway, page } = await openQuestionPage();
      await selectChatLayoutAction(page, "Open split view");
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expectCount(panes, 2);
      await expectCount(panes.locator(composerSelector), 2);
      expect(await gateway.getRequests("question.list")).toHaveLength(1);

      const request = questionRecord(`question-split-${status}-${closeSubmittingPane}`);

      await gateway.emitGatewayEvent("question.requested", request);
      const panels = panelFor(page, "Where should I deploy?");
      await expectCount(panels, 2);
      await expectQuestionAttention(page, request.questions[0]!.question);

      const answers = { answers: { deploy_target: ["Staging"] } };
      const result: QuestionResolveResult =
        status === "answered" ? { status, answers } : { status };
      if (closeSubmittingPane) {
        await gateway.deferNext("question.resolve");
      } else {
        await gateway.setMethodResponse("question.resolve", result);
      }
      const submittingIndex = closeSubmittingPane ? 1 : 0;
      const submittingPane = panes.nth(submittingIndex);
      const submittingPanel = panels.nth(submittingIndex);
      if (status === "answered") {
        await submittingPanel.getByRole("radio", { name: /Staging/ }).click();
      }
      await submittingPanel
        .getByRole("button", { name: status === "answered" ? "Submit" : "Skip", exact: true })
        .click();
      const resolveRequest = await gateway.waitForRequest("question.resolve");
      expect(resolveRequest.params).toEqual(
        status === "answered" ? { id: request.id, answers } : { id: request.id, cancel: true },
      );
      expect(await gateway.getRequests("question.resolve")).toHaveLength(1);
      const remainingPanes = page.locator("openclaw-chat-pane");
      if (closeSubmittingPane) {
        await selectChatLayoutAction(submittingPane, "Close pane");
        await expectCount(remainingPanes, 1);
        await expectQuestionAttention(page, request.questions[0]!.question);
        await gateway.resolveDeferred("question.resolve", result);
      }
      const remainingCount = closeSubmittingPane ? 1 : 2;

      await expectCount(panels, 0);
      await expectCount(remainingPanes.locator(composerSelector), remainingCount);
      await expect
        .poll(() =>
          page
            .locator(".chat-question-summary")
            .filter({ hasText: status === "answered" ? "Staging" : "Skipped" })
            .count(),
        )
        .toBe(remainingCount);
      await expectQuestionAttention(page, null);
    },
  );

  it("restores the composer when reconnect recovery cannot find an old question", async () => {
    const { gateway, page } = await openQuestionPage();
    const favicon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect.poll(() => favicon.getAttribute("href")).toMatch(/^\/favicon\.svg(?:\?|$)/);
    const originalFavicon = await favicon.getAttribute("href");
    const request = questionRecord("question-expired-during-disconnect");

    await gateway.setMethodResponse("question.list", { questions: [request] });
    const panel = await showQuestion(page, gateway, request);
    await expectQuestionAttention(page, request.questions[0]!.question);
    await expect.poll(() => favicon.getAttribute("href")).toMatch(/^data:image\/svg\+xml,/);

    await gateway.setMethodResponse("question.list", { questions: [] });
    await gateway.setMethodResponse("question.get", {
      __mockError: {
        code: "INVALID_REQUEST",
        message: "question was not found",
        details: { reason: "QUESTION_NOT_FOUND" },
      },
    });
    await gateway.closeLatest();
    const recovery = await gateway.waitForRequest("question.get");
    expect(recovery.params).toEqual({ id: request.id });

    await expectCount(panel, 0);
    await expectQuestionAttention(page, null);
    await page.locator(composerSelector).waitFor();
    await expect.poll(() => favicon.getAttribute("href")).toBe(originalFavicon);
  });
});
