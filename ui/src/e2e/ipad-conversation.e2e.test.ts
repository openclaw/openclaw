import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { withControlUiSettledTargets } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { agentEvent, chatEvent } from "./chat-flow-fixtures.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { exactButton, layoutBox, right } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { recordedToolCall } from "./recorded-tool.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "iPad native conversation parity" });
const sessionKey = "agent:main:ipad-conversation";
const childSessionKey = "agent:main:ipad-layout-child";
const viewports = [
  { width: 1180, height: 820 },
  { width: 820, height: 1180 },
];
const avatar =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#207d82"/></svg>',
  ).toString("base64");
const definition = createThemeDefinitionFixture({
  workingIndicator: "claw",
  workingPhrases: ["Clawing"],
});
const theme = {
  id: "ipad-proof/layout",
  ...definition,
  source: "plugin",
  pluginId: "ipad-proof",
  modes: ["dark"],
};
const catalog = {
  current: { id: theme.id, mode: "dark", scope: "gateway", overrides: {} },
  theme,
  definition,
  themes: [theme],
};
const firstText = "I’ll inspect the stylesheet first.";
const secondText = "The stylesheet is readable; checking is complete.";
const finalText = "The iPad conversation is ready.";
const message = (role: string, content: unknown, phase?: string) => ({ role, content, phase });
const toolResult = (toolCallId: string, toolName: string, content: unknown) => ({
  role: "toolResult",
  content,
  toolCallId,
  toolName,
});
const history = [
  message("user", "Inspect the layout."),
  message("assistant", firstText, "commentary"),
  recordedToolCall("read-layout", "read", { path: "layout.css" }),
  toolResult("read-layout", "read", "The stylesheet is readable."),
  message("assistant", secondText, "commentary"),
  message("assistant", finalText, "final_answer"),
].map((entry, index) =>
  Object.assign(entry, {
    timestamp: Date.UTC(2026, 10, 17, 6, 0, index),
    runId: "layout",
    __openclaw: { id: "ipad-" + index, runId: "layout" },
  }),
);

async function openConversation(page: Page) {
  await seedChatSettings(page, suite.server.baseUrl, {
    chatBubbleSessionKeys: [sessionKey],
    theme: theme.id,
    themeMode: "dark",
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      __OPENCLAW_NATIVE_EMBED__: {
        platform: "ios",
        formFactor: "pad",
        surface: "conversation",
      },
      __OPENCLAW_NATIVE_CONVERSATION__: { contract: 1 },
      webkit: {
        messageHandlers: {
          openclawConversation: { postMessage: () => Promise.resolve({ ok: true }) },
        },
      },
    });
  });
  const identity = { assistantName: "Layout agent", assistantAvatar: avatar };
  const gateway = await installMockGateway(page, {
    sessionKey,
    ...identity,
    presenceUsers: [{ self: true, id: "profile-ipad", name: "Riley" }],
    historyMessages: history,
    sessions: [{ key: sessionKey, sessionId: "ipad-conversation" }],
    methodResponses: {
      "config.get": themeConfigResponse(theme.id, "dark"),
      "themes.list": catalog,
      "themes.get": catalog,
    },
  });
  await page.route("**/control-ui-config.json", (route) =>
    route.fulfill({
      json: { ...createControlUiMockBootstrapConfig(identity), chatBubblesEnabled: true },
    }),
  );
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  return gateway;
}

async function checkConversation({ page }: { page: Page }) {
  const gateway = await openConversation(page);
  const pane = page.locator(".chat-pane-cache__pane--visible");
  const chat = pane.locator("section.chat");
  await browserExpect(page.locator("openclaw-chat-page[data-native-conversation]")).toBeVisible();
  await browserExpect(
    page.locator("openclaw-app-sidebar, openclaw-app-topbar, .native-embed-header"),
  ).toHaveCount(0);
  await browserExpect(chat).toHaveClass(/chat--bubbles/);
  const final = chat.getByText(finalText, { exact: true });
  const first = chat.getByText(firstText, { exact: true });
  const second = chat.getByText(secondText, { exact: true });
  const presented = <T>(targets: (typeof first)[], read: () => Promise<T>) =>
    withControlUiSettledTargets(
      page,
      pane,
      targets,
      () =>
        Promise.all(
          targets.map((target) => browserExpect(target).toBeInViewport({ ratio: 1 })),
        ).then(read),
      { animations: "disabled" },
    );
  const image = chat.locator("img.chat-avatar.assistant:visible");
  const summary = chat.locator(".chat-activity-group > button");
  const expectAvatars = async (count: number) => {
    await browserExpect(image).toHaveCount(count);
    for (const element of await image.all()) {
      await browserExpect(element).toHaveAttribute("src", avatar);
      await browserExpect(element).toHaveJSProperty("complete", true);
      await browserExpect(element).toHaveJSProperty("naturalWidth", 32);
    }
  };
  await expectAvatars(1);
  await browserExpect(summary).toHaveAttribute("aria-expanded", "false");
  expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(36);
  await presented([image, first, summary, second, final], () =>
    browserExpect(chat.locator(".chat-text:visible, .chat-activity-group > button")).toHaveText([
      "Inspect the layout.",
      firstText,
      "Read files",
      secondText,
      finalText,
    ]),
  );
  expect(await chat.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const toolToggle = exactButton(chat.locator(".chat-tool-msg-summary"), "Read layout.css");
  const toolBody = chat.locator(".chat-tool-msg-body");
  await summary.click();
  await browserExpect(summary).toHaveAttribute("aria-expanded", "true");
  await browserExpect(toolToggle).toHaveAttribute("aria-expanded", "false");
  // The linked filename owns the row center; the gutter opens the disclosure.
  await toolToggle.click({ position: { x: 8, y: 8 } });
  await browserExpect(toolToggle).toHaveAttribute("aria-expanded", "true");
  await presented([summary, toolBody], async () => {
    await browserExpect(toolBody).toBeVisible();
    await browserExpect(toolBody).toContainText("The stylesheet is readable.");
  });
  await toolToggle.click({ position: { x: 8, y: 8 } });
  await browserExpect(toolToggle).toHaveAttribute("aria-expanded", "false");
  await browserExpect(toolBody).not.toBeVisible();
  await summary.click();
  await browserExpect(summary).toHaveAttribute("aria-expanded", "false");

  const trigger = pane.locator(".chat-header-session-menu__trigger");
  await trigger.click();
  const menu = pane.locator("openclaw-chat-header-session-menu");
  await menu.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Speech bubbles", exact: true }).click();
  await trigger.click();
  await browserExpect(chat).not.toHaveClass(/chat--bubbles/);
  await pane.locator(".agent-chat__composer-combobox textarea").fill("Continue checking.");
  const startedAt = Date.now();
  await page.clock.setFixedTime(startedAt);
  await pane.getByRole("button", { name: "Send message", exact: true }).click();
  const send = await gateway.waitForRequest("chat.send");
  expect(send.params).toMatchObject({
    sessionKey,
    message: "Continue checking.",
    idempotencyKey: expect.any(String),
  });
  const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
  const working = chat.locator(".chat-working-indicator");
  const status = working.locator(".chat-working-indicator__status");
  const composer = pane.locator(".agent-chat__composer-combobox");
  const assertStatusLayout = async (preceding: typeof first, waiting: boolean) => {
    const anchor = waiting ? working.locator("svg") : status;
    const targets = [first, working, status, anchor, preceding, composer];
    const [prose, line, label, signal, previous, input] = await presented(targets, () =>
      Promise.all(targets.map(layoutBox)),
    );
    if (!prose || !line || !label || !signal || !previous || !input) {
      throw new Error("Expected rendered bounds for every iPad conversation status target");
    }
    // Compare actual rendered content bounds, not the viewport or a CSS inset.
    expect(Math.abs(line.x - prose.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(signal.x - prose.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(line.x - previous.x)).toBeLessThanOrEqual(3);
    if (waiting) {
      expect(label.x).toBeGreaterThanOrEqual(right(signal));
      expect(label.x - right(signal)).toBeLessThanOrEqual(12);
    }
    expect(line.y).toBeGreaterThanOrEqual(previous.y + previous.height - 1);
    expect(line.y + line.height).toBeLessThanOrEqual(input.y);
    const flow = await working.evaluate((element) => {
      const thread = element.closest(".chat-thread");
      let viewportPinned = false;
      for (let node: Element | null = element; node && node !== thread; node = node.parentElement) {
        viewportPinned ||= ["fixed", "sticky"].includes(getComputedStyle(node).position);
      }
      return Boolean(thread) && !element.closest(".chat-bubble") && !viewportPinned;
    });
    expect(flow).toBe(true);
  };
  await page.clock.setFixedTime(startedAt + 31_000);
  await browserExpect(working.locator(".chat-reading-indicator svg")).toBeVisible();
  await browserExpect(status.locator(".chat-working-indicator__elapsed")).toHaveText("31s");
  await browserExpect(status.locator("openclaw-working-phrase")).toContainText("Clawing");
  await assertStatusLayout(final, true);
  await gateway.emitGatewayEvent(
    "agent",
    agentEvent(runId, sessionKey, "usage", { outputTokens: 2400 }, 1, startedAt + 31_000),
  );
  const statusItems = status.locator(":scope > :not(.sr-only)");
  await presented([working, status], () =>
    browserExpect(statusItems).toHaveText(["2.4k output tokens", "·", "31s"]),
  );
  await browserExpect(status.locator("openclaw-working-phrase")).toHaveCount(0);
  // Exercise the same real handoff events as chat-subagent-waiting: a yielded
  // parent with an unfinished child, never a fabricated DOM or status override.
  const snapshot = (
    row: Pick<GatewaySessionRow, "key"> & Partial<GatewaySessionRow>,
    offset: number,
    activeRunIds: string[],
    fields: Partial<GatewaySessionRow> = {},
  ) => ({
    kind: "direct" as const,
    status: "running" as const,
    ...row,
    ...fields,
    activeRunIds,
    hasActiveRun: activeRunIds.length > 0,
    updatedAt: startedAt + offset,
    snapshotAt: startedAt + offset,
  });
  const parent = snapshot(
    {
      key: sessionKey,
      sessionId: "ipad-conversation",
      hasActiveSubagentRun: true,
      childSessions: [childSessionKey],
      startedAt,
    },
    31_000,
    [runId],
  );
  const child = snapshot(
    {
      key: childSessionKey,
      sessionId: "ipad-layout-child",
      classification: "subagent",
      label: "Verify layout",
      parentSessionKey: sessionKey,
      spawnedBy: sessionKey,
      startedAt: startedAt + 1,
    },
    31_000,
    ["layout-child-run"],
  );
  await gateway.setSessionsListResponse(sessionsListResponse([parent, child]));
  await gateway.emitGatewayEvent("sessions.changed", {
    sessionKey: child.key,
    reason: "run-start",
    ts: child.updatedAt,
    session: child,
    ancestorSessions: [parent],
  });
  await browserExpect(working.getByText("1 subagent running", { exact: true })).toBeVisible();
  const delegatedText = "The layout verification is delegated.";
  const delegatedMessages = [
    message("user", "Continue checking."),
    recordedToolCall("launch-layout", "sessions_spawn", {
      label: child.label,
      task: "Verify the layout.",
    }),
    toolResult(
      "launch-layout",
      "sessions_spawn",
      JSON.stringify({
        status: "accepted",
        childSessionKey,
      }),
    ),
    message("assistant", [
      { type: "text", text: delegatedText },
      { type: "toolCall", id: "yield-layout", name: "sessions_yield", arguments: {} },
    ]),
    toolResult("yield-layout", "sessions_yield", [{ type: "text", text: '{"status":"yielded"}' }]),
  ].map((entry, index) =>
    Object.assign(entry, {
      timestamp: startedAt + index,
      __openclaw: { id: "delegated-" + index, seq: history.length + index + 1, runId },
    }),
  );
  const waitingParent = snapshot(parent, 32_000, [], { endedAt: startedAt + 4 });
  await gateway.setSessionsListResponse(sessionsListResponse([waitingParent, child]));
  await gateway.setMethodResponse("chat.history", {
    messages: [...history, ...delegatedMessages],
    sessionId: parent.sessionId,
    sessionInfo: waitingParent,
    inFlightRun: null,
  });
  const yieldResult = delegatedMessages.at(-1)!;
  await gateway.emitGatewayEvent("session.message", {
    sessionKey,
    message: yieldResult,
    messageId: yieldResult["__openclaw"].id,
    messageSeq: yieldResult["__openclaw"].seq,
    hasActiveRun: true,
    session: parent,
  });
  const historyReads = (await gateway.getRequests("chat.history")).length;
  await gateway.emitGatewayEvent("chat", chatEvent(runId, sessionKey, "final", { yielded: true }));
  await gateway.waitForRequest("chat.history", { after: historyReads });
  const prose = chat.locator(".chat-text");
  const delegated = prose.getByText(delegatedText, { exact: true });
  await browserExpect(status).toHaveText("Wait for subagents");
  await browserExpect(
    working.locator(
      ".chat-reading-indicator, openclaw-working-phrase, .chat-working-indicator__elapsed, .chat-working-indicator__tokens",
    ),
  ).toHaveCount(0);
  await browserExpect(pane.locator(".agent-chat__composer-run-status--waiting")).toHaveCount(0);
  await assertStatusLayout(delegated, false);
  expect(await gateway.getRequests("chat.history", { sessionKey: child.key })).toHaveLength(0);
  const resumedRunId = "layout-parent-resumed";
  const resumedParent = snapshot(parent, 33_000, [resumedRunId], {
    startedAt: startedAt + 33_000,
    hasActiveSubagentRun: false,
  });
  await gateway.setSessionsListResponse(
    sessionsListResponse([
      resumedParent,
      snapshot(child, 32_000, [], { status: "done", endedAt: startedAt + 32_000 }),
    ]),
  );
  await gateway.emitGatewayEvent("sessions.changed", {
    sessionKey,
    reason: "run-start",
    ts: resumedParent.updatedAt,
    session: resumedParent,
    ancestorSessions: [],
  });
  await browserExpect(status).not.toHaveText("Wait for subagents");
  await browserExpect(working.locator(".chat-reading-indicator svg")).toBeVisible();
  const followupText = "The follow-up is complete.";
  await gateway.emitChatFinal({ sessionKey, runId: resumedRunId, text: followupText });
  await browserExpect(prose.getByText(followupText, { exact: true })).toBeVisible();
  await browserExpect(working).toHaveCount(0);
  await expectAvatars(2);
}

suite.define(() => {
  it.each(viewports)("keeps identity, activity and waiting status at $width×$height", (viewport) =>
    suite.withPage(
      { viewport, locale: "en-US", serviceWorkers: "block", hasTouch: true },
      checkConversation,
    ),
  );
});
