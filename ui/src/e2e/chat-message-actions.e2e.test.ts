// Real-browser proof for inline and context-menu chat message actions.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CHAT_MESSAGE_MAX_CHARS } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pollText, pollCount, pollAttribute } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat message actions",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

// Pad past the transport preview limit while retaining representative Markdown.
const FULL_ASSISTANT_CONTENT_FILLER_LINE =
  "Repeat neutral filler text to exceed the transport preview limit while staying deterministic and readable.\n";

const realisticFullAssistantContent = `# Deployment report

- service: payment-gateway

1. Build the release artifact and run smoke tests.

~~~ts
export function verifyRollout(serviceName: string): Promise<boolean> {
  return healthCheck(serviceName);
}
~~~

Reference: src/services/payment-gateway/deploy.ts:88

${FULL_ASSISTANT_CONTENT_FILLER_LINE.repeat(75)}
## Final verification

All health checks passed and the rollout is complete.`;

async function withPage(
  run: Parameters<typeof suite.withPage>[1],
  options: BrowserContextOptions = {},
) {
  await suite.withPage(
    {
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
      ...options,
    },
    run,
  );
}

function historyMessage(
  role: string,
  content: unknown,
  id: string,
  seq: number,
  offset: number,
  metadata = {},
) {
  return { role, content, timestamp: Date.now() + offset, __openclaw: { id, seq, ...metadata } };
}

const expectClipboard = (page: Page, text: string) =>
  expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
const replyText = (preview: Locator) => pollText(preview.locator(".chat-reply-preview__text"));

async function contextAction(bubble: Locator, name: string) {
  await bubble.click({ button: "right" });
  await bubble.page().locator(".chat-reply-context-menu").getByRole("menuitem", { name }).click();
}

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.style.colorScheme = nextMode;
  }, mode);
  await pollAttribute(page.locator("html"), "data-theme-mode").toBe(mode);
}

async function expectHoverTooltip(button: Locator, text: string, side?: "right"): Promise<void> {
  await button.hover();
  const measure = () =>
    button.evaluate((element) => {
      const host = [
        ...document.querySelectorAll<HTMLElement & { anchor?: Element | null }>("openclaw-tooltip"),
      ].find(
        (candidate) =>
          candidate.anchor === element ||
          candidate.shadowRoot
            ?.querySelector<HTMLSlotElement>("slot:not([name])")
            ?.assignedElements({ flatten: true })[0] === element,
      );
      const tooltip = host?.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface[popover]");
      const anchor =
        host?.anchor ??
        host?.shadowRoot
          ?.querySelector<HTMLSlotElement>("slot:not([name])")
          ?.assignedElements({ flatten: true })[0];

      // Apple modifier glyphs pair hidden text with an aria-hidden SVG whose
      // markup whitespace is in textContent but never rendered or announced.
      const readableText = (node: Node): string =>
        node instanceof Element && node.getAttribute("aria-hidden") === "true"
          ? ""
          : node instanceof Text
            ? node.data
            : node instanceof HTMLSlotElement
              ? Array.from(node.assignedNodes({ flatten: true }), readableText).join("")
              : Array.from(node.childNodes, readableText).join("");
      const body = tooltip;
      const slot = body?.querySelector<HTMLSlotElement>('slot[name="content"]');
      const textNode =
        slot?.assignedNodes({ flatten: true }).find((node) => node.textContent?.trim()) ??
        body?.querySelector(".tooltip-content");
      const range = textNode ? document.createRange() : null;
      if (range && textNode) {
        range.selectNodeContents(textNode);
      }
      const bodyRect = body?.getBoundingClientRect();
      const textRect = range?.getBoundingClientRect();
      const anchorRect = element.getBoundingClientRect();
      return {
        centerOffset: bodyRect
          ? bodyRect.top + bodyRect.height / 2 - (anchorRect.top + anchorRect.height / 2)
          : Number.POSITIVE_INFINITY,
        gap: bodyRect ? bodyRect.left - anchorRect.right : Number.NEGATIVE_INFINITY,
        height: bodyRect?.height ?? 0,
        textTopInset: bodyRect && textRect ? textRect.top - bodyRect.top : Number.POSITIVE_INFINITY,
        width: bodyRect?.width ?? 0,

        anchorMatches: anchor === element,
        hidden: tooltip ? getComputedStyle(tooltip).display === "none" : true,
        open: host?.hasAttribute("open") ?? false,
        popupActive: tooltip?.matches(":popover-open") ?? false,
        text: tooltip ? readableText(tooltip).trim() : "",
      };
    });
  await expect.poll(measure).toMatchObject({
    anchorMatches: true,
    hidden: false,
    open: true,
    popupActive: true,
    text,
  });
  const bounds = await measure();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.textTopInset).toBeLessThan(12);
  if (side === "right") {
    expect(bounds.gap).toBeGreaterThanOrEqual(0);
    expect(Math.abs(bounds.centerOffset)).toBeLessThanOrEqual(1);
  }
}

async function expectHoverColor(
  button: Locator,
  colorVariable: "--accent" | "--danger",
): Promise<void> {
  const restingColor = await button.evaluate((element) => getComputedStyle(element).color);
  const hoverColor = await button.evaluate((_, cssVariable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${cssVariable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, colorVariable);
  expect(restingColor).not.toBe(hoverColor);
  await button.hover();
  await expect
    .poll(() => button.evaluate((element) => getComputedStyle(element).color))
    .toBe(hoverColor);
}

suite.define(() => {
  it.each([
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])("keeps view-only subagent reply actions absent on $name", (viewport) =>
    withPage(
      async ({ page, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(suite.server.baseUrl).origin,
        });
        const parent = {
          key: "agent:main:reply-parent",
          kind: "direct",
          label: "Workspace review",
        };
        const child = {
          key: "agent:main:subagent:reply-child",
          kind: "direct",
          label: "Check dependencies",
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: "done",
          hasActiveRun: false,
        };
        const message = "The dependency review is complete.";
        const gateway = await installMockGateway(page, {
          sessionKey: child.key,
          sessions: [parent, child],
          historyMessages: [
            historyMessage(
              "user",
              "Review the workspace dependencies.",
              "review-request",
              1,
              -2_000,
            ),
            historyMessage("assistant", message, "review-result", 2, -1_000),
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, child.key));
        await gateway.waitForRequest("chat.startup");
        await page.getByText("View-only subagent", { exact: true }).waitFor();
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const bubble = activePane.locator('.chat-bubble[data-entry-id="review-result"]');
        await bubble.waitFor({ state: "visible" });
        await bubble[viewport.name === "mobile" ? "tap" : "hover"]();
        expect(await page.locator(".agent-chat__composer-combobox textarea").count()).toBe(0);
        expect.soft(await page.getByRole("button", { name: "Reply to message" }).count()).toBe(0);
        const copy = activePane.locator(".chat-group.assistant .chat-copy-btn");
        await copy.click();
        await expectClipboard(page, message);
        await bubble.click({ button: "right" });
        const menu = page.locator(".chat-reply-context-menu");
        await menu.waitFor({ state: "visible" });
        expect.soft(await menu.getByRole("menuitem", { name: "Reply to message" }).count()).toBe(0);
        await page.keyboard.press("Escape");
        await page
          .locator('.chat-bubble[data-entry-id="review-request"]')
          .click({ button: "right" });
        expect(
          await menu.getByRole("menuitem", { name: "Fork from here", exact: true }).count(),
        ).toBe(1);
        await page.keyboard.press("Escape");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await page.getByRole("button", { name: "Open parent session", exact: true }).click();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await bubble[viewport.name === "mobile" ? "tap" : "hover"]();
        await activePane
          .locator(".chat-group.assistant")
          .getByRole("button", { name: "Reply to message", exact: true })
          .click();
        await replyText(activePane).toBe(message);
      },
      {
        hasTouch: viewport.name === "mobile",
        viewport,
      },
    ),
  );

  it.each([
    { role: "assistant", kind: "document" },
    { role: "assistant", kind: "image" },
    { role: "user", kind: "document" },
    { role: "user", kind: "image" },
  ] as const)("replies to $role $kind-only messages with a linked source", ({ role, kind }) =>
    withPage(async ({ page }) => {
      await page.route("https://files.example.test/**", (route) => route.abort());
      const sourceId = `attachment-only-${role}-${kind}`;
      const runId = "attachment-reply-run";
      const fileName = kind === "image" ? "openclaw-banner.png" : "report.pdf";
      const imageUrl =
        kind === "image"
          ? `data:image/png;base64,${(
              await readFile(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"))
            ).toString("base64")}`
          : "";
      const source = {
        role,
        content:
          kind === "image"
            ? [{ type: "image", url: imageUrl, fileName, alt: "OpenClaw banner" }]
            : role === "user"
              ? []
              : [
                  {
                    type: "attachment",
                    attachment: {
                      kind: "document",
                      url: "https://files.example.test/report.pdf",
                      label: fileName,
                      mimeType: "application/pdf",
                    },
                  },
                ],
        timestamp: Date.now() - 2_000,
        ...(role === "assistant" ? { phase: "final_answer", stopReason: "stop" } : {}),
        __openclaw: {
          id: sourceId,
          seq: 2,
          ...(role === "assistant" ? { runId } : {}),
          ...(role === "user" && kind === "document"
            ? {
                media: [
                  {
                    kind: "document",
                    url: "https://files.example.test/report.pdf",
                    contentType: "application/pdf",
                    fileName,
                  },
                ],
              }
            : {}),
        },
      };
      const gateway = await installMockGateway(page, {
        historyMessages:
          role === "assistant"
            ? [
                historyMessage(
                  "user",
                  "Create the requested file.",
                  "attachment-request",
                  1,
                  -3_000,
                  { idempotencyKey: `${runId}:user` },
                ),
                source,
              ]
            : [source],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const bubble = page.locator(`.chat-bubble[data-entry-id="${sourceId}"]`);
      await bubble.waitFor({ state: "visible" });
      if (kind === "image") {
        await expect
          .poll(() =>
            bubble
              .locator(".chat-message-image")
              .evaluate((image) =>
                image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
              ),
          )
          .toBeGreaterThan(0);
      } else {
        await bubble.getByText(fileName, { exact: true }).waitFor({ state: "visible" });
      }
      expect(await bubble.locator(".chat-text").count()).toBe(0);
      const group = bubble.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-group ')]",
      );
      if (role === "assistant") {
        expect(await group.getAttribute("data-chat-row-key")).toContain("agent-run:");
      }
      await group.hover();
      const reply = group.getByRole("button", { name: "Reply to message", exact: true });
      expect(await reply.count()).toBe(1);
      expect(await group.getByRole("button", { name: "Copy as markdown" }).count()).toBe(0);
      await reply.click();
      const preview = page.locator(".chat-reply-preview").filter({
        has: page.getByRole("button", { name: "Cancel reply" }),
      });
      await replyText(preview).toBe(fileName);
      await preview.getByRole("button", { name: "Cancel reply" }).click();
      await bubble.click({ button: "right", position: { x: 2, y: 2 } });
      await page
        .locator(".chat-reply-context-menu")
        .getByRole("menuitem", { name: "Reply to message" })
        .click();
      await replyText(preview).toBe(fileName);
      const text = "Please explain this file.";
      await page.locator(".agent-chat__composer-combobox textarea").fill(text);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ message: text, replyToId: sourceId });
      const sentPreview = page.locator(".chat-reply-attribution--inline");
      await pollCount(sentPreview.getByRole("button")).toBe(1);
      await sentPreview.getByRole("button").click();
      await expect
        .poll(() =>
          bubble.evaluate((element) => element.classList.contains("chat-bubble--reply-target")),
        )
        .toBe(true);
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(0);
    }),
  );

  it("keeps assistant actions hidden when the user message is last", () =>
    withPage(async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          historyMessage("assistant", "Earlier assistant reply.", "earlier-assistant", 1, -4_000),
          historyMessage("user", "A question between replies.", "middle-user", 2, -3_000),
          historyMessage("assistant", "Latest assistant lead-in.", "latest-assistant", 3, -2_000),
          historyMessage(
            "assistant",
            "Latest assistant reply.",
            "latest-assistant-final",
            4,
            -1_500,
          ),
          historyMessage("user", "A newer user follow-up.", "latest-user", 5, -1_000),
        ],
      });

      const presentation = (group: Locator) =>
        group.evaluate((element) => {
          const footer = element.querySelector<HTMLElement>(":scope > .chat-group-footer");
          const action = element.querySelector<HTMLElement>(
            ":scope > .chat-group-footer .chat-group-footer-actions button",
          );
          return [action, footer].map((node) =>
            node ? [getComputedStyle(node).opacity, getComputedStyle(node).pointerEvents] : null,
          );
        });
      const expectPresentation = (group: Locator, visible: boolean) =>
        expect
          .poll(() => presentation(group))
          .toEqual(
            Array.from({ length: 2 }, () => [visible ? "1" : "0", visible ? "auto" : "none"]),
          );
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.mouse.move(0, 0);
      const assistantGroups = page.locator(".chat-group.assistant");
      await pollCount(assistantGroups).toBe(2);
      const earlierAssistant = assistantGroups.first();
      const latestAssistant = assistantGroups.last();
      await latestAssistant.getByText("Latest assistant reply.", { exact: true }).waitFor();
      const intermediateId = await latestAssistant
        .locator(".chat-bubble")
        .first()
        .getAttribute("data-message-id");
      const intermediateOwner = latestAssistant.locator(
        `[data-message-actions-for="${intermediateId}"]`,
      );
      const inlineAction = intermediateOwner.locator("button").first();
      const inlinePresentation = () =>
        inlineAction.evaluate((element) => {
          const { opacity, pointerEvents } = getComputedStyle(element);
          return { opacity, pointerEvents };
        });
      await pollCount(inlineAction).toBe(1);
      await expectPresentation(earlierAssistant, false);
      await expectPresentation(latestAssistant, false);
      await expect.poll(inlinePresentation).toEqual({ opacity: "0", pointerEvents: "none" });

      await page.setViewportSize({ width: 390, height: 844 });
      await pollCount(intermediateOwner).toBe(1);
      await pollCount(latestAssistant.locator(".chat-message-actions-row")).toBe(0);
      expect(await intermediateOwner.locator("..").getAttribute("class")).toContain(
        "chat-message-footer",
      );
      await expectPresentation(latestAssistant, false);
      await latestAssistant.locator(".chat-bubble").last().dispatchEvent("pointerup", {
        button: 0,
        pointerType: "touch",
      });
      await expectPresentation(latestAssistant, true);
      await expect.poll(inlinePresentation).toEqual({ opacity: "1", pointerEvents: "auto" });
    }));

  it("shares tooltip styling and dismissal across message metadata, actions, and file hints", () =>
    withPage(
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Tooltip proof. See /workspace/tooltip-proof.txt." }],
              timestamp: Date.now() - 5 * 60_000,
              model: "openai/gpt-5.6-luna",
              usage: { input: 12_000, output: 300, cost: { total: 0.12 } },
              __openclaw: { id: "tooltip-proof", seq: 1 },
            },
          ],
        });
        const openTooltip = page.locator(".tooltip-surface[popover]:popover-open");
        const popupStyle = () =>
          openTooltip.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              background: style.backgroundColor,
              border: style.border,
              radius: style.borderRadius,
              padding: style.padding,
              fontSize: style.fontSize,
            };
          });
        await page.goto(`${suite.server.baseUrl}chat`);
        const group = page.locator(".chat-group.assistant").filter({ hasText: "Tooltip proof." });
        await group
          .locator(".chat-text")
          .first()
          .tap({ position: { x: 4, y: 4 } });
        const timestamp = group.locator(".msg-meta__summary");
        await timestamp.hover();
        await pollCount(openTooltip).toBe(1);
        await group.locator(".msg-meta__details").waitFor({ state: "visible" });
        const metadataStyle = await popupStyle();
        expect(await group.locator(".msg-meta__details").textContent()).toContain("gpt-5.6-luna");
        expect(await group.locator(".msg-meta__cost").textContent()).toContain("$0.12");

        await timestamp.click();
        await page.mouse.move(0, 0);
        await pollCount(openTooltip).toBe(1);
        const reply = group.getByRole("button", { name: "Reply to message" });
        await expectHoverTooltip(reply, "Reply");
        await pollCount(openTooltip).toBe(1);
        expect(await popupStyle()).toEqual(metadataStyle);
        await page.keyboard.press("Escape");
        await pollCount(openTooltip).toBe(0);

        const file = group.locator("a").filter({ hasText: "tooltip-proof.txt" });
        await file.hover();
        await pollCount(openTooltip).toBe(1);
        const filePath = group.locator("openclaw-tooltip[open] .markdown-file-tooltip__path");
        await filePath.waitFor({ state: "visible" });
        expect(await filePath.textContent()).toBe("/workspace/tooltip-proof.txt");
        expect(await popupStyle()).toEqual(metadataStyle);
        expect(await file.getAttribute("title")).toBe("");

        await page.setViewportSize({ width: 390, height: 844 });
        await timestamp.tap();
        await pollCount(openTooltip).toBe(1);
        await group.locator(".msg-meta__details").waitFor({ state: "visible" });
        const bounds = await openTooltip.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await timestamp.tap();
        await pollCount(openTooltip).toBe(0);
      },
      {
        hasTouch: true,
      },
    ));

  it("keeps oversized history notices consistent through recovery and message actions", () =>
    withPage(async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(suite.server.baseUrl).origin,
      });
      const messageText = "Reply and context menu action proof.";
      const privateThinking = "private reply reasoning";
      const visibleThinkingAnswer = "Visible reply context only.";
      const fullAssistantContent = realisticFullAssistantContent;
      const rawOversizedMarker = "[chat.history omitted: message too large]";
      const oversizedNotice = "This message is too large to display here.";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.message.get"],
        historyMessages: [
          ...(
            [
              ["assistant-action-proof", "assistant", messageText, false],
              ["user-action-separator", "user", "Keep the next assistant message separate.", false],
              [
                "assistant-thinking-proof",
                "assistant",
                `<thinking>${privateThinking}</thinking>${visibleThinkingAnswer}`,
                false,
              ],
              ["user-truncated-separator", "user", "Keep the truncated message separate.", false],
              ["assistant-full-message", "assistant", rawOversizedMarker, true],
              ["oversized-user", "user", rawOversizedMarker, true],
            ] as const
          ).map(([id, role, text, truncated], index) =>
            historyMessage(
              role,
              [{ type: "text", text }],
              id,
              index + 1,
              index,
              truncated ? { truncated, reason: "oversized" } : {},
            ),
          ),
          ...["read_file", "run_command"].map((toolName, index) =>
            Object.assign(
              historyMessage(
                "toolResult",
                rawOversizedMarker,
                `oversized-tool-${index + 1}`,
                index + 7,
                index + 6,
                { truncated: true, reason: "oversized" },
              ),
              { toolCallId: `oversized-tool-call-${index + 1}`, toolName },
            ),
          ),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await setThemeMode(page, "dark");
      const applePlatform = process.platform === "darwin";
      const commandPaletteShortcut = applePlatform ? "⌘K" : "Ctrl+K";
      const newSessionShortcut = applePlatform ? "⌘⇧O" : "Ctrl+Shift+O";
      await expectHoverTooltip(
        page.locator(".sidebar-rail .sidebar-new-session"),
        `New conversation ${newSessionShortcut}`,
        "right",
      );
      await expectHoverTooltip(
        page.getByRole("button", { name: "Command palette" }),
        `Command palette ${commandPaletteShortcut}`,
        "right",
      );
      await expectHoverTooltip(
        page.locator('[data-navigation-view][aria-pressed="true"]'),
        "Sessions",
        "right",
      );
      await page.evaluate(() => {
        const tooltip = document.createElement("openclaw-tooltip");
        tooltip.setAttribute("content", "First line\nSecond line");
        const trigger = document.createElement("button");
        trigger.textContent = "Multiline tooltip probe";
        trigger.style.position = "fixed";
        trigger.style.inset = "80px auto auto 280px";
        trigger.style.zIndex = "10000";
        tooltip.append(trigger);
        document.body.append(tooltip);
      });
      const multilineTooltipButton = page.getByRole("button", {
        name: "Multiline tooltip probe",
      });
      await expectHoverTooltip(multilineTooltipButton, "First line\nSecond line");
      expect(
        await multilineTooltipButton.evaluate((element) => {
          const content = element
            .closest("openclaw-tooltip")
            ?.shadowRoot?.querySelector<HTMLElement>(".tooltip-content");
          if (!content) {
            return 0;
          }
          const range = document.createRange();
          range.selectNodeContents(content);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        }),
      ).toBe(2);
      await multilineTooltipButton.evaluate((element) =>
        element.closest("openclaw-tooltip")?.remove(),
      );
      const group = page.locator(".chat-group.assistant").filter({ hasText: messageText });
      const bubble = group.locator(".chat-bubble");
      await bubble.waitFor({ state: "visible" });

      const thinkingGroup = page
        .locator(".chat-group.assistant")
        .filter({ hasText: visibleThinkingAnswer });
      await thinkingGroup.hover();
      await thinkingGroup.getByRole("button", { name: "Reply to message" }).click();
      const thinkingReplyPreview = page.locator(".chat-reply-preview");
      await thinkingReplyPreview.waitFor({ state: "visible" });
      expect(await thinkingReplyPreview.locator(".chat-reply-preview__text").textContent()).toBe(
        visibleThinkingAnswer,
      );
      expect(await thinkingReplyPreview.textContent()).not.toContain(privateThinking);
      await thinkingReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await group.hover();

      const inlineActions = group.locator(".chat-group-footer-actions button");
      expect(
        await inlineActions.evaluateAll((buttons) => buttons.map((button) => button.ariaLabel)),
      ).toEqual(["Reply to message", "Copy as markdown"]);
      for (const button of await inlineActions.all()) {
        await expectHoverColor(button, "--accent");
      }
      const replyButton = group.getByRole("button", { name: "Reply to message" });
      await expectHoverTooltip(replyButton, "Reply");

      await group.hover();
      await replyButton.click();
      const replyPreview = page.locator(".chat-reply-preview");
      await replyPreview.waitFor({ state: "visible" });
      expect(await replyPreview.locator(".chat-reply-preview__text").textContent()).toBe(
        messageText,
      );
      await replyPreview.getByRole("button", { name: "Cancel reply" }).click();

      const menu = page.locator(".chat-reply-context-menu");
      const selectedText = "context menu";
      const nextTimer = () =>
        page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            }),
        );
      await bubble.evaluate((element, text) => {
        const selection = window.getSelection();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const candidate = walker.currentNode;
          const start = (candidate.textContent ?? "").indexOf(text);
          if (!(candidate instanceof Text) || start < 0) {
            continue;
          }
          const range = document.createRange();
          range.setStart(candidate, start);
          range.setEnd(candidate, start + text.length);
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
        throw new Error(`Could not find selectable text: ${text}`);
      }, selectedText);
      await bubble.click({ button: "right" });
      await menu.waitFor({ state: "visible" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Copy",
        "Reply",
        "Copy as markdown",
      ]);
      await nextTimer();
      expect(await page.locator(".chat-selection-popup").count()).toBe(0);
      await bubble.dispatchEvent("pointerup", {
        button: 0,
        ctrlKey: true,
        pointerType: "mouse",
      });
      await nextTimer();
      expect(await page.locator(".chat-selection-popup").count()).toBe(0);
      await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
      await expectClipboard(page, selectedText);

      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await bubble.click({ button: "right" });
      await menu.waitFor({ state: "visible" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Reply",
        "Copy as markdown",
      ]);
      expect(
        await menu.getByRole("menuitem", { name: "Reply to message" }).locator("svg").count(),
      ).toBe(0);

      await menu.getByRole("menuitem", { name: "Copy as markdown" }).click();
      await expectClipboard(page, messageText);

      const fullTextBubble = page.locator('.chat-bubble[data-entry-id="assistant-full-message"]');
      const fullTextGroup = fullTextBubble.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-group ')]",
      );
      const fullMessageRequest = await gateway.waitForRequest("chat.message.get");
      expect(fullMessageRequest.params).toMatchObject({
        sessionKey: "agent:main:main",
        messageId: "assistant-full-message",
        maxChars: CHAT_MESSAGE_MAX_CHARS,
      });
      await pollText(fullTextBubble.locator(".chat-text")).toContain(oversizedNotice);
      expect(await fullTextBubble.getAttribute("data-message-text")).toBe(oversizedNotice);
      expect(await page.locator("body").textContent()).not.toContain(rawOversizedMarker);
      const fullTextReplyPreview = page.locator(".chat-reply-preview");
      await contextAction(fullTextBubble, "Copy as markdown");
      await expectClipboard(page, oversizedNotice);
      await contextAction(fullTextBubble, "Reply to message");
      await replyText(fullTextReplyPreview).toBe(oversizedNotice);
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();
      await gateway.resolveDeferred("chat.message.get", {
        ok: true,
        message: { role: "assistant", content: fullAssistantContent },
      });
      const fullTail = fullTextBubble.getByRole("heading", { name: "Final verification" });
      await fullTail.waitFor({ state: "visible" });
      expect(await fullTextBubble.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await fullTextBubble.getByRole("button", { name: "Show less" }).count()).toBe(0);
      await fullTail.scrollIntoViewIfNeeded();

      await fullTextGroup.hover();
      await fullTextGroup.getByRole("button", { name: "Copy as markdown" }).click();
      await expectClipboard(page, fullAssistantContent);
      await fullTextGroup.getByRole("button", { name: "Reply to message" }).click();
      await replyText(fullTextReplyPreview).toContain("# Deployment report");
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await contextAction(fullTextBubble, "Copy as markdown");
      await expectClipboard(page, fullAssistantContent);
      await contextAction(fullTextBubble, "Reply to message");
      await replyText(fullTextReplyPreview).toContain("# Deployment report");
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      const userOversizedBubble = page.locator('.chat-bubble[data-entry-id="oversized-user"]');
      expect(await userOversizedBubble.getAttribute("data-message-text")).toBe(oversizedNotice);
      await pollText(userOversizedBubble.locator(".chat-text")).toContain(oversizedNotice);

      const activitySummary = page.locator(".chat-activity-group__summary").last();
      await activitySummary.click();
      const groupedToolBubble = page.locator('.chat-bubble[data-entry-id="oversized-tool-1"]');
      await groupedToolBubble.waitFor({ state: "visible" });
      expect(await groupedToolBubble.getAttribute("data-message-text")).toBe(oversizedNotice);
      await groupedToolBubble.click({ button: "right" });
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Reply",
        "Copy as markdown",
      ]);
      await menu.getByRole("menuitem", { name: "Copy as markdown" }).click();
      await expectClipboard(page, oversizedNotice);
      await contextAction(groupedToolBubble, "Reply to message");
      await replyText(fullTextReplyPreview).toBe(oversizedNotice);
      await fullTextReplyPreview.getByRole("button", { name: "Cancel reply" }).click();

      await setThemeMode(page, "light");
      await fullTail.scrollIntoViewIfNeeded();
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(1);
    }));
});
