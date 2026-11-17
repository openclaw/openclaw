import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatEvent } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
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
const history = [
  message("user", "Inspect the layout."),
  message("assistant", firstText, "commentary"),
  message("assistant", [
    { type: "toolCall", id: "read-layout", name: "read", arguments: { path: "layout.css" } },
  ]),
  {
    ...message("toolResult", "The stylesheet is readable."),
    toolCallId: "read-layout",
    toolName: "read",
  },
  message("assistant", secondText, "commentary"),
  message("assistant", finalText, "final_answer"),
].map((entry, index) => ({
  ...entry,
  timestamp: Date.UTC(2026, 10, 17, 6, 0, index),
  runId: "layout",
  __openclaw: { id: "ipad-" + index, runId: "layout" },
}));

suite.define(() => {
  it("keeps identity, ordered activity and plain waiting status across iPad widths", async () => {
    await suite.withPage(
      { viewport: viewports[0], locale: "en-US", serviceWorkers: "block", hasTouch: true },
      async ({ page }) => {
        await page.addInitScript(
          ({ key, session, themeId }) => {
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
            localStorage.setItem(
              key,
              JSON.stringify({
                chatBubbleSessionKeys: [session],
                theme: themeId,
                themeMode: "dark",
              }),
            );
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            session: sessionKey,
            themeId: theme.id,
          },
        );
        const identity = { assistantName: "Layout agent", assistantAvatar: avatar };
        const gateway = await installMockGateway(page, {
          sessionKey,
          ...identity,
          historyMessages: history,
          sessions: [
            {
              key: sessionKey,
              sessionId: "ipad-conversation",
              kind: "direct",
              status: "done",
              hasActiveRun: false,
              activeRunIds: [],
            },
          ],
          presenceUsers: [
            {
              self: true,
              id: "profile-ipad",
              name: "Riley",
              identity: { type: "profile", id: "profile-ipad" },
            },
          ],
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
        const pane = page.locator(".chat-pane-cache__pane--visible");
        const chat = pane.locator("section.chat");
        await browserExpect(
          page.locator("openclaw-chat-page[data-native-conversation]"),
        ).toBeVisible();
        await browserExpect(
          page.locator("openclaw-app-sidebar, openclaw-app-topbar, .native-embed-header"),
        ).toHaveCount(0);
        await browserExpect(chat).toHaveClass(/chat--bubbles/);
        const final = chat.getByText(finalText, { exact: true });
        const first = chat.getByText(firstText, { exact: true });
        const second = chat.getByText(secondText, { exact: true });
        const image = chat.locator("img.chat-avatar.assistant:visible");
        const summary = chat.locator(".chat-activity-group > button");
        const capture = async (
          stage: string,
          width: number,
          targets: Parameters<typeof takeControlUiScreenshotFrame>[2],
        ) => {
          await page.mouse.move(0, 0);
          const frame = await takeControlUiScreenshotFrame(page, pane, targets, {
            animations: "disabled",
            elements: targets,
          });
          writeFileSync(path.join(suite.artifactDir, stage + "-" + width + ".png"), frame.png);
          return frame;
        };
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await browserExpect(final).toBeVisible();
          await browserExpect(first).toBeVisible();
          await browserExpect(second).toBeVisible();
          await browserExpect(image).toHaveCount(1);
          await browserExpect(image).toHaveAttribute("src", avatar);
          await expect
            .poll(() =>
              image.evaluate(
                (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
              ),
            )
            .toBe(true);
          await browserExpect(summary).toHaveCount(1);
          await browserExpect(summary).toHaveText("Read files");
          await browserExpect(summary).toHaveAttribute("aria-expanded", "false");
          expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(36);
          const ordered = await chat
            .locator(".chat-text:visible, .chat-activity-group > button")
            .allTextContents();
          expect(ordered.map((text) => text.trim())).toEqual([
            "Inspect the layout.",
            firstText,
            "Read files",
            secondText,
            finalText,
          ]);
          expect(await chat.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
          await capture("transcript", viewport.width, [image, first, summary, second, final]);
        }
        const toolSummary = chat.locator(".chat-tool-msg-summary");
        const toolToggle = toolSummary.getByRole("button", {
          name: "Read layout.css",
          exact: true,
        });
        const toolBody = chat.locator(".chat-tool-msg-body");
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await summary.click();
          await browserExpect(summary).toHaveAttribute("aria-expanded", "true");
          await browserExpect(toolSummary).toContainText("layout.css");
          await browserExpect(toolToggle).toHaveAttribute("aria-expanded", "false");
          // The linked filename owns the row center; the gutter opens the disclosure.
          await toolToggle.click({ position: { x: 8, y: 8 } });
          await browserExpect(toolToggle).toHaveAttribute("aria-expanded", "true");
          await browserExpect(toolBody).toContainText("The stylesheet is readable.");
          await capture("tool-disclosure", viewport.width, [summary, toolBody]);
          await toolToggle.click({ position: { x: 8, y: 8 } });
          await browserExpect(toolToggle).toHaveAttribute("aria-expanded", "false");
          await browserExpect(toolBody).not.toBeVisible();
          await summary.click();
          await browserExpect(summary).toHaveAttribute("aria-expanded", "false");
        }

        // The existing plain mode owns the spinner and unbubbled status line.
        const trigger = pane.locator(".chat-header-session-menu__trigger");
        await trigger.click();
        const menu = pane.locator("openclaw-chat-header-session-menu > .chat-header-session-menu");
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
        const captureStatus = async (
          stage: "waiting" | "subagent-waiting",
          width: number,
          preceding: typeof first,
        ) => {
          const anchor = stage === "waiting" ? working.locator("svg") : status;
          const frame = await capture(stage, width, [
            first,
            working,
            status,
            anchor,
            preceding,
            composer,
          ]);
          const [prose, line, label, signal, previous, input] = frame.elements.map(
            (entry) => entry.bounds,
          );
          // Compare actual rendered content bounds, not the viewport or a CSS inset.
          expect(Math.abs(line!.x - prose!.x)).toBeLessThanOrEqual(3);
          expect(Math.abs(signal!.x - prose!.x)).toBeLessThanOrEqual(3);
          expect(Math.abs(line!.x - previous!.x)).toBeLessThanOrEqual(3);
          if (stage === "waiting") {
            expect(label!.x).toBeGreaterThanOrEqual(signal!.x + signal!.width);
            expect(label!.x - signal!.x - signal!.width).toBeLessThanOrEqual(12);
          }
          expect(line!.y).toBeGreaterThanOrEqual(previous!.y + previous!.height - 1);
          expect(line!.y + line!.height).toBeLessThanOrEqual(input!.y);
          const flow = await working.evaluate((element) => {
            const thread = element.closest(".chat-thread");
            const positions = [];
            for (
              let node: Element | null = element;
              node && node !== thread;
              node = node.parentElement
            ) {
              positions.push(getComputedStyle(node).position);
            }
            return {
              inTranscript: Boolean(thread),
              bubbled: Boolean(element.closest(".chat-bubble")),
              viewportPinned: positions.some(
                (position) => position === "fixed" || position === "sticky",
              ),
            };
          });
          expect(flow).toEqual({ inTranscript: true, bubbled: false, viewportPinned: false });
          writeFileSync(
            path.join(suite.artifactDir, stage + "-" + width + ".json"),
            JSON.stringify(
              { viewport: page.viewportSize(), prose, line, label, signal, previous, input, flow },
              null,
              2,
            ),
          );
        };
        await browserExpect(working).toBeVisible();
        await page.clock.setFixedTime(startedAt + 31_000);
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await browserExpect(working.locator(".chat-reading-indicator svg")).toBeVisible();
          await browserExpect(status.locator(".chat-working-indicator__elapsed")).toHaveText("31s");
          await browserExpect(status.locator("openclaw-working-phrase")).toContainText("Clawing");
          await captureStatus("waiting", viewport.width, final);
        }
        await gateway.emitGatewayEvent("agent", {
          sessionKey,
          runId,
          stream: "usage",
          seq: 1,
          ts: startedAt + 31_000,
          data: { outputTokens: 2400 },
        });
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await browserExpect(status.locator(".chat-working-indicator__tokens")).toHaveText(
            "2.4k output tokens",
          );
          expect(await status.locator(":scope > :not(.sr-only)").allTextContents()).toEqual([
            "2.4k output tokens",
            "·",
            "31s",
          ]);
          await browserExpect(status.locator("openclaw-working-phrase")).toHaveCount(0);
          await capture("output-tokens", viewport.width, [working, status]);
        }
        // Exercise the same real handoff events as chat-subagent-waiting: a yielded
        // parent with an unfinished child, never a fabricated DOM or status override.
        const parent = {
          key: sessionKey,
          sessionId: "ipad-conversation",
          kind: "direct",
          status: "running",
          hasActiveRun: true,
          activeRunIds: [runId],
          hasActiveSubagentRun: true,
          childSessions: [childSessionKey],
          startedAt,
          updatedAt: startedAt + 31_000,
          snapshotAt: startedAt + 31_000,
        } satisfies GatewaySessionRow;
        const child = {
          key: childSessionKey,
          sessionId: "ipad-layout-child",
          kind: "direct",
          classification: "subagent",
          label: "Verify layout",
          parentSessionKey: sessionKey,
          spawnedBy: sessionKey,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["layout-child-run"],
          startedAt: startedAt + 1,
          updatedAt: startedAt + 31_000,
          snapshotAt: startedAt + 31_000,
        } satisfies GatewaySessionRow;
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
          message("assistant", [
            {
              type: "toolCall",
              id: "launch-layout",
              name: "sessions_spawn",
              arguments: { label: child.label, task: "Verify the layout." },
            },
          ]),
          {
            ...message(
              "toolResult",
              JSON.stringify({ status: "accepted", childSessionKey: child.key }),
            ),
            toolCallId: "launch-layout",
            toolName: "sessions_spawn",
          },
          message("assistant", [
            { type: "text", text: delegatedText },
            { type: "toolCall", id: "yield-layout", name: "sessions_yield", arguments: {} },
          ]),
          {
            ...message("toolResult", [{ type: "text", text: '{"status":"yielded"}' }]),
            toolCallId: "yield-layout",
            toolName: "sessions_yield",
          },
        ].map((entry, index) => ({
          ...entry,
          timestamp: startedAt + index,
          __openclaw: { id: "delegated-" + index, seq: history.length + index + 1, runId },
        }));
        const waitingParent = {
          ...parent,
          hasActiveRun: false,
          activeRunIds: [],
          endedAt: startedAt + 4,
          updatedAt: startedAt + 32_000,
          snapshotAt: startedAt + 32_000,
        };
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
          messageId: yieldResult.__openclaw.id,
          messageSeq: yieldResult.__openclaw.seq,
          hasActiveRun: true,
          session: parent,
        });
        const historyReads = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent(
          "chat",
          chatEvent(runId, sessionKey, "final", { yielded: true }),
        );
        await gateway.waitForRequest("chat.history", { after: historyReads });
        const delegated = chat.locator(".chat-text").getByText(delegatedText, { exact: true });
        await browserExpect(delegated).toBeVisible();
        await browserExpect(status).toHaveText("Wait for subagents");
        await browserExpect(working).toHaveCount(1);
        await browserExpect(
          working.locator(
            ".chat-reading-indicator, openclaw-working-phrase, .chat-working-indicator__elapsed, .chat-working-indicator__tokens",
          ),
        ).toHaveCount(0);
        await browserExpect(pane.locator(".agent-chat__composer-run-status--waiting")).toHaveCount(
          0,
        );
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await captureStatus("subagent-waiting", viewport.width, delegated);
        }
        expect(await gateway.getRequests("chat.history", { sessionKey: child.key })).toHaveLength(
          0,
        );
        // A parent continuation replaces the wait; its final removes the status.
        const resumedRunId = "layout-parent-resumed";
        const resumedParent = {
          ...parent,
          activeRunIds: [resumedRunId],
          hasActiveSubagentRun: false,
          updatedAt: startedAt + 33_000,
          snapshotAt: startedAt + 33_000,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([
            resumedParent,
            {
              ...child,
              status: "done",
              hasActiveRun: false,
              activeRunIds: [],
              endedAt: startedAt + 32_000,
            },
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
        await gateway.emitChatFinal({
          sessionKey,
          runId: resumedRunId,
          text: "The follow-up is complete.",
        });
        await browserExpect(
          chat.locator(".chat-text").getByText("The follow-up is complete.", { exact: true }),
        ).toBeVisible();
        await browserExpect(working).toHaveCount(0);
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await browserExpect(image).toHaveCount(2);
          expect(
            await image.evaluateAll((images) => images.map((image) => image.getAttribute("src"))),
          ).toEqual([avatar, avatar]);
          await expect
            .poll(() =>
              image.evaluateAll((images: HTMLImageElement[]) =>
                images.every((element) => element.complete && element.naturalWidth > 0),
              ),
            )
            .toBe(true);
        }
      },
    );
  });
});
