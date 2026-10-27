import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  defineMobileFooterActionCases,
  expectStableNamePosition,
  readActionTapArea,
  readFooterGeometry,
  sampleMetadataReveal,
} from "./chat-attributed-identity.test-support.ts";
import {
  requireRecord,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI attributed chat identity",
  startServerBeforeBrowser: true,
});

function profile(id: string, name: string) {
  return { id, name, identity: { type: "profile" as const, id } };
}

function userMessage(
  sender: ReturnType<typeof profile>,
  content: string | Array<{ type: string; text: string }>,
  timestamp: number,
  identity?: { id?: string; seq?: number; senderProfileAvatarUrl?: string },
) {
  return {
    role: "user",
    content,
    timestamp,
    __openclaw: {
      ...identity,
      senderId: sender.id,
      senderIdentity: sender.identity,
      senderName: sender.name,
    },
  };
}

function assistant(content: string | Array<{ type: string; text: string }>, timestamp: number) {
  return { role: "assistant", content, timestamp };
}

const mainSession = "agent:main:main";
const desktop = { viewport: { height: 760, width: 1180 } };
const ready = "Ready for a delivery check.";
const composer = (page: Page) => page.locator(".agent-chat__composer-combobox textarea");
const openChat = (page: Page) => page.goto(controlUiSessionUrl(suite.server.baseUrl, mainSession));
const tapBubble = (group: Locator) =>
  group.locator(".chat-bubble").dispatchEvent("pointerup", { pointerType: "touch" });

function expectStableFooter(
  current: Awaited<ReturnType<typeof readFooterGeometry>>,
  resting: Awaited<ReturnType<typeof readFooterGeometry>>,
  rtl = false,
) {
  expectStableNamePosition(current.name, resting.name);
  const { identity, actions } = current;
  expect(rtl ? identity.left - actions.right : actions.left - identity.right).toBeCloseTo(8, 0);
}

function readRunId(params: unknown, nonempty = false) {
  const id = requireRecord(params).idempotencyKey;
  if (typeof id !== "string" || (nonempty && !id.trim())) {
    throw new Error("Expected chat.send run ID");
  }
  return id;
}

async function send(page: Page, prompt: string) {
  await composer(page).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function deliveryFixture(page: Page, prompt: string) {
  const gateway = await installMockGateway(page, {
    historyMessages: [assistant([{ text: ready, type: "text" }], Date.now() - 1_000)],
    presenceUsers: [
      { ...profile("c3e32452-0467-47e5-aafa-233cd5dae29f", "Collin Johnson"), self: true },
    ],
  });
  await openChat(page);
  await page.locator(".chat-group.assistant").getByText(ready).waitFor();
  await gateway.deferNext("chat.send");
  await send(page, prompt);
  const request = await gateway.waitForRequest("chat.send");
  const group = page.locator(".chat-group.user", { hasText: prompt });
  await group.waitFor();
  return { gateway, request, group };
}

const rejectDelivery = (gateway: Awaited<ReturnType<typeof installMockGateway>>) =>
  gateway.rejectDeferred("chat.send", {
    code: "INVALID_REQUEST",
    message: "Mock delivery failure.",
  });

suite.define(() => {
  defineMobileFooterActionCases(suite);

  it("keeps every restored message width inside the mobile safe area", async () => {
    await suite.withPage({ viewport: { width: 932, height: 430 } }, async ({ page, context }) => {
      const scenario = {
        presenceUsers: [{ ...profile("profile-morgan", "Morgan"), self: true }],
        historyMessages: [
          { role: "assistant", content: "Keep the restored reading column clear of the notch." },
        ],
      };
      const settingsProtocol = await context.newCDPSession(page);
      await settingsProtocol.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { left: 44, right: 0, top: 0, bottom: 0 },
      });
      await installMockGateway(page, scenario);
      await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
      const widthInput = page.locator("[data-settings-chat-message-width]");
      const chat = await context.newPage();
      await installMockGateway(chat, scenario);
      const protocol = await context.newCDPSession(chat);
      await protocol.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { left: 44, right: 0, top: 0, bottom: 0 },
      });
      for (const messageWidth of [
        "none",
        "min-content",
        "max-content",
        "48rem",
        "82%",
        "min(768px, 82%)",
      ]) {
        const label = `restored message width ${messageWidth}`;
        await page.bringToFront();
        await widthInput.fill(messageWidth);
        await widthInput.press("Tab");
        await expect
          .poll(
            () =>
              page.evaluate(
                (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
                controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              ),
            { message: label },
          )
          .toBe(messageWidth);
        // Every value is restored by a fresh Chat document; only Settings stays warm.
        await chat.bringToFront();
        await chat.goto(controlUiSessionUrl(suite.server.baseUrl, mainSession));
        const transcript = chat.locator(".chat-thread-inner");
        await expect(
          transcript.getByText("Keep the restored reading column clear of the notch."),
          label,
        ).toBeAttached();
        for (const direction of ["ltr", "rtl"]) {
          await chat.evaluate((dir) => {
            document.documentElement.dir = dir;
          }, direction);
          for (const frame of [transcript, chat.locator(".agent-chat__composer-shell")]) {
            const bounds = await frame.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return { left: rect.left, right: rect.right };
            });
            const frameLabel = `${label} (${direction})`;
            expect(bounds.left, frameLabel).toBeGreaterThanOrEqual(44 + 16);
            expect(bounds.right, frameLabel).toBeLessThanOrEqual(932 - 16);
            expect(bounds.left - 44, frameLabel).toBeCloseTo(932 - bounds.right, 0);
          }
        }
      }
    });
  });

  it.each([true, false])(
    "keeps attributed mobile content in one usable column at every viewport (profile: %s)",
    async (profiled) => {
      const viewports = [
        { width: 320, height: 860, safeAreaLeft: 0 },
        { width: 328, height: 860, safeAreaLeft: 0 },
        { width: 390, height: 860, safeAreaLeft: 0 },
        { width: 430, height: 860, safeAreaLeft: 0 },
        { width: 932, height: 430, safeAreaLeft: 0 },
        { width: 800, height: 430, safeAreaLeft: 44 },
      ].map((viewport) =>
        Object.assign(viewport, { sessionKey: `agent:main:attributed-mobile-${viewport.width}` }),
      );
      await suite.withPage(
        { viewport: { width: 320, height: 860 }, hasTouch: true },
        async ({ page, context }) => {
          const protocol = await context.newCDPSession(page);
          const morgan = profile("profile-morgan", "Morgan");
          const now = Date.now();
          const gateway = await installMockGateway(page, {
            sessionKey: viewports[0]!.sessionKey,
            sessions: viewports.map(({ width, sessionKey }) =>
              createControlUiSessionRow(sessionKey, `Attributed mobile ${width}`, now),
            ),
            presenceUsers: profiled ? [{ ...morgan, self: true }] : [],
            sessionTranscripts: Object.fromEntries(
              viewports.map(({ sessionKey }) => [
                sessionKey,
                {
                  messages: [
                    userMessage(morgan, "Keep the phone transcript readable.", now - 20_000),
                    assistant(
                      "The response uses the available transcript width.\n\n```ts\nconsole.log('readable code');\n```",
                      now - 10_000,
                    ),
                  ],
                },
              ]),
            ),
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, viewports[0]!.sessionKey));
          for (const { width, height, safeAreaLeft, sessionKey } of viewports) {
            const label = `${width} × ${height} px (profile: ${profiled})`;
            await page.evaluate(() => {
              document.documentElement.dir = "ltr";
            });
            await page.setViewportSize({ width, height });
            await protocol.send("Emulation.setSafeAreaInsetsOverride", {
              insets: { left: safeAreaLeft, right: 0, top: 0, bottom: 0 },
            });
            await navigateToControlUiSession(page, sessionKey);
            const pane = page.locator(".chat-pane-cache__pane--active");
            const transcript = pane.locator(".chat-thread-inner");
            await expect(
              transcript.getByText("The response uses the available transcript width."),
              label,
            ).toBeVisible();
            const expectColumn = async (content: Locator, phase: string) => {
              const frame = await transcript.boundingBox();
              const bounds = await content.boundingBox();
              const columnLabel = `${label}: ${phase}`;
              expect(frame, columnLabel).not.toBeNull();
              expect(bounds, columnLabel).not.toBeNull();
              expect(bounds!.x, columnLabel).toBeCloseTo(frame!.x, 0);
              expect(bounds!.width, columnLabel).toBeCloseTo(frame!.width, 0);
            };
            for (const direction of ["ltr", "rtl"]) {
              await page.evaluate((dir) => {
                document.documentElement.dir = dir;
              }, direction);
              await expectColumn(
                pane.locator(".agent-chat__composer-shell"),
                `${direction} composer`,
              );
              const frame = await transcript.boundingBox();
              const directionLabel = `${label} (${direction})`;
              expect(frame!.x, directionLabel).toBeGreaterThanOrEqual(safeAreaLeft + 16);
              expect(frame!.x + frame!.width, directionLabel).toBeLessThanOrEqual(width - 16);
              expect(frame!.x - safeAreaLeft, directionLabel).toBeCloseTo(
                width - frame!.x - frame!.width,
                0,
              );
              await expectColumn(
                pane.locator(".chat-group.assistant > .chat-group-messages"),
                `${direction} assistant`,
              );
              await expect(
                pane.locator(".chat-group .chat-avatar:visible"),
                directionLabel,
              ).toHaveCount(0);
            }
            await pane
              .locator(".agent-chat__composer-combobox textarea")
              .fill("Read the example file.");
            await pane.getByRole("button", { name: "Send message" }).click();
            const request = await gateway.waitForRequest("chat.send", { match: { sessionKey } });
            const runId = readRunId(request.params);
            await expect(pane.locator(".chat-working-indicator"), label).toBeVisible();
            const working = pane.locator(".chat-group--working > .chat-group-messages");
            await expectColumn(working, "working indicator");
            await expect(working, label).toHaveCSS("padding-inline-start", "0px");
            const toolCallId = `mobile-read-${width}`;
            await gateway.emitGatewayEvent("agent", {
              runId,
              sessionKey,
              stream: "tool",
              seq: 1,
              ts: Date.now(),
              data: {
                name: "read",
                phase: "start",
                toolCallId,
                args: { path: "example.txt" },
              },
            });
            await expect(
              pane.locator(`[data-message-id^="tool:assistant:${toolCallId}"]`),
              label,
            ).toBeVisible();
            await expectColumn(
              pane.locator(".chat-group.assistant > .chat-group-messages").last(),
              "tool response",
            );
            await gateway.emitChatFinal({
              runId,
              sessionKey,
              text: "The example file is readable.",
            });
            await expect(
              transcript.getByText("The example file is readable."),
              label,
            ).toBeVisible();
            await gateway.emitGatewayEvent("session.message", {
              sessionKey,
              messageId: `mobile-peer-message-${width}`,
              messageSeq: 5,
              message: userMessage(
                profile("profile-riley", "Riley"),
                "Riley joined this conversation.",
                Date.now(),
              ),
            });
            // Fixture delivery does not wait for the new row's presentation.
            await expect(
              transcript.getByText("Riley joined this conversation."),
              label,
            ).toBeVisible();
            if (profiled) {
              const peer = pane.locator(".chat-group--peer", {
                hasText: "Riley joined this conversation.",
              });
              await expect(peer.locator(".chat-sender-name"), label).toHaveText("Riley");
              await expect(peer.locator(".chat-group-footer"), label).toHaveCSS("opacity", "1");
            }
            const thread = pane.locator(".chat-thread");
            if (height === 430) {
              // The first message can leave the virtual window after new turns.
              // Return to it before checking its attributed identity.
              await scrollChatThreadToTop(page);
              await waitForChatScrollIdle(page);
              expect(await thread.evaluate((element) => element.scrollTop), label).toBe(0);
            }
            if (!profiled) {
              const own = pane.locator(".chat-group.user", {
                hasText: "Keep the phone transcript readable.",
              });
              await expect(own, label).not.toHaveClass(/chat-group--peer/u);
              await expect(own, label).toHaveCSS("justify-content", "end");
            }
            if (height === 430) {
              await thread.press("End");
              await expect
                .poll(() => thread.evaluate((element) => element.scrollTop), { message: label })
                .toBeGreaterThan(0);
              await expectColumn(pane.locator(".agent-chat__composer-shell"), "scrolled composer");
            }
          }
        },
      );
    },
  );

  it("uses one avatar placement and keeps shared-thread authors readable", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const now = Date.now();
      const riley = profile("profile-riley", "Riley");
      const colin = profile("profile-colin", "Colin");
      const alexandria = profile("profile-alexandria", "Alexandria Montgomery-Winter");
      const ownPrompt = "Can we keep one clear avatar and show who wrote each message?";
      const peerPrompt = "This is much easier to scan in a team conversation.";
      const longPrompt = "My longer identity should remain fixed too.";
      const intro = "The shared thread now keeps every participant easy to identify.";
      const answer = "Yes — one author marker is enough, with the name kept readable.";
      await page.route("**/api/users/*/avatar*", (route) =>
        route.fulfill({ status: 404, body: "No avatar" }),
      );
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.rewind"],
        presenceUsers: [
          { ...riley, self: true, email: "riley@example.test" },
          { ...colin, email: "colin@example.test" },
          { ...alexandria, email: "alexandria@example.test" },
        ],
        historyMessages: [
          assistant(intro, now - 180_000),
          userMessage(riley, ownPrompt, now - 120_000, { id: "riley-message", seq: 2 }),
          assistant(answer, now - 90_000),
          userMessage(colin, peerPrompt, now - 30_000, { id: "colin-message", seq: 4 }),
          assistant("Long participant names keep the same stable layout.", now - 20_000),
          userMessage(alexandria, longPrompt, now - 10_000, { id: "alexandria-message", seq: 6 }),
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page
        .locator('[data-entry-id="colin-message"] .chat-text')
        .getByText(peerPrompt)
        .waitFor();

      const userGroups = page.locator(".chat-group.user");
      await expect(userGroups).toHaveCount(3);
      for (const [index, initials] of ["R", "C", "AM"].entries()) {
        const avatar = userGroups.nth(index).locator(".chat-avatar:visible");
        await expect(avatar).toHaveCount(1);
        await expect(avatar).toHaveText(initials);
      }
      await expect(page.locator(".sidebar-identity-card openclaw-viewer-avatar")).toContainText(
        "R",
      );

      await expect(
        page.locator(".chat-group-footer--persistent-identity .chat-sender-name"),
      ).toHaveText(["Riley", "Colin", "Alexandria Montgomery-Winter"]);
      await expect(page.locator(".chat-group-footer .chat-author-avatar")).toHaveCount(0);
      const peerGroup = userGroups.nth(1);
      const longNamePeerGroup = userGroups.last();
      const hoverDetails = peerGroup.locator(".chat-group-timestamp");
      await expect(hoverDetails).toHaveCSS("opacity", "0");

      const restingPeerGeometry = await readFooterGeometry(peerGroup);
      await peerGroup.hover();
      await expect(hoverDetails).toHaveCSS("opacity", "1");
      await expect(page.locator(".chat-group-footer .chat-author-avatar")).toHaveCount(0);
      const hoveredPeerGeometry = await readFooterGeometry(peerGroup);
      expectStableFooter(hoveredPeerGeometry, restingPeerGeometry);

      await page.mouse.move(0, 0);
      const restingLongNameGeometry = await readFooterGeometry(longNamePeerGroup);
      await longNamePeerGroup.hover();
      const hoveredLongNameGeometry = await readFooterGeometry(longNamePeerGroup);
      expectStableFooter(hoveredLongNameGeometry, restingLongNameGeometry);

      await page.mouse.move(0, 0);
      const peerReply = peerGroup.getByRole("button", { name: "Reply to message" });
      await peerReply.focus();
      await expect(hoverDetails).toHaveCSS("opacity", "1");
      const focusedPeerGeometry = await readFooterGeometry(peerGroup);
      expectStableFooter(focusedPeerGeometry, restingPeerGeometry);
      await expect(peerReply).toHaveCSS("opacity", "0.6");

      await page.evaluate(() => {
        document.documentElement.dir = "rtl";
        document.documentElement.lang = "ar";
        document.body.tabIndex = -1;
        document.body.focus();
      });
      await page.mouse.move(0, 0);
      await expect(hoverDetails).toHaveCSS("opacity", "0");
      const restingRtlGeometry = await readFooterGeometry(peerGroup);
      await peerGroup.hover();
      await expect(hoverDetails).toHaveCSS("opacity", "1");
      const hoveredRtlGeometry = await readFooterGeometry(peerGroup);
      expectStableFooter(hoveredRtlGeometry, restingRtlGeometry, true);

      await page.evaluate(() => {
        document.documentElement.dir = "ltr";
        document.documentElement.lang = "en";
      });
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ height: 760, width });
        // The prior native rewind/cancel interaction can leave fine-pointer hover/focus behind.
        await page.mouse.move(0, 0);
        await page.getByRole("textbox", { name: "Chat composer" }).focus();
        const restingTouchGeometry = await readFooterGeometry(longNamePeerGroup);
        const restingTouchHeight = (await longNamePeerGroup.boundingBox())?.height;
        await tapBubble(longNamePeerGroup);
        await expect(longNamePeerGroup).toHaveClass(/\bchat-group--meta-revealed\b/u);
        const revealed = await readFooterGeometry(longNamePeerGroup);
        expectStableFooter(revealed, restingTouchGeometry);
        // Wrapped metadata and 44px touch controls still share one row.
        const { actions, identity, footer } = revealed;
        expect(actions.top).toBeLessThan(identity.bottom);
        expect(actions.bottom).toBeGreaterThan(identity.top);
        expect(actions.right).toBeCloseTo(footer.right, 0);
        expect(actions.left).toBeGreaterThanOrEqual(0);
        expect(footer.right).toBeLessThanOrEqual(width);
        const reply = longNamePeerGroup.getByRole("button", { name: "Reply to message" });
        await expect(reply).toHaveCSS("opacity", "0.6");
        for (const control of [
          reply,
          longNamePeerGroup.getByRole("button", { name: "Rewind", exact: true }),
        ]) {
          const target = await readActionTapArea(control);
          expect(target.width).toBeGreaterThanOrEqual(44);
          expect(target.height).toBeGreaterThanOrEqual(44);
          expect(target.hitCorners).toBe(4);
          if (width === 390 && (await control.getAttribute("aria-label")) === "Rewind") {
            await page.mouse.click(target.left + 2, target.top + target.height - 2);
            const confirmation = page.locator(".chat-confirm-popover");
            await expect(confirmation).toBeVisible();
            await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect(confirmation).toHaveCount(0);
          }
        }
        expect((await longNamePeerGroup.boundingBox())?.height).toBe(restingTouchHeight);
        await tapBubble(longNamePeerGroup);
        await expect(longNamePeerGroup).not.toHaveClass(/\bchat-group--meta-revealed\b/u);
      }

      // Leave the mobile editor before measuring metadata-only interactions.
      // Otherwise focus transfer also collapses the composer and changes the scroll range.
      await page.locator(".chat-thread").focus();
      await expect(page.locator(".agent-chat__composer-shell")).toHaveAttribute(
        "data-composer-editing",
        "false",
      );
      await waitForChatScrollIdle(page);
      for (const group of [
        userGroups.first(),
        peerGroup,
        page.locator(".chat-group.assistant").first(),
      ]) {
        await group.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        for (const interaction of ["touch", "focus"] as const) {
          const frames = await sampleMetadataReveal(group, interaction);
          for (const frame of frames.slice(1)) {
            expect(frame).toEqual(frames[0]);
          }
          await expect(group.locator(".chat-group-timestamp")).toHaveCSS("opacity", "1");
        }
      }

      await page.setViewportSize({ height: 760, width: 1180 });
      const ownGroup = userGroups.first();
      const ownName = ownGroup.locator(".chat-sender-name");
      const ownBubble = ownGroup.locator(".chat-bubble");
      await page.mouse.move(0, 0);
      await expect(ownGroup.locator(".chat-group-timestamp")).toHaveCSS("opacity", "0");
      const restingNameBox = await ownName.boundingBox();
      const ownBubbleBox = await ownBubble.boundingBox();
      await ownGroup.hover();
      const ownTimestamp = ownGroup.locator(".chat-group-timestamp");
      await expect(ownTimestamp).toHaveCSS("opacity", "1");
      const hoveredNameBox = await ownName.boundingBox();
      const timestampBox = await ownTimestamp.boundingBox();
      expect(hoveredNameBox?.x).toBe(restingNameBox?.x);
      expect((restingNameBox?.x ?? 0) + (restingNameBox?.width ?? 0)).toBeCloseTo(
        (ownBubbleBox?.x ?? 0) + (ownBubbleBox?.width ?? 0),
        0,
      );
      expect((timestampBox?.x ?? 0) + (timestampBox?.width ?? 0)).toBeLessThan(
        hoveredNameBox?.x ?? 0,
      );

      // Own, peer and assistant renderers must align timestamps with 44px actions.
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ height: 760, width });
        await waitForChatScrollIdle(page);
        for (const group of [ownGroup, peerGroup, page.locator(".chat-group.assistant").last()]) {
          const restingHeight = (await group.boundingBox())?.height;
          await tapBubble(group);
          await expect(group).toHaveClass(/\bchat-group--meta-revealed\b/u);
          const alignment = await group.locator(".chat-group-footer").evaluate((footer) => {
            const centerY = (element: Element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.top + bounds.height / 2;
            };
            const buttons = [...footer.querySelectorAll(".chat-group-footer-actions button")];
            return {
              time: centerY(footer.querySelector(".chat-group-timestamp")!),
              icons: [...footer.querySelectorAll(".chat-group-footer-actions button svg")].map(
                centerY,
              ),
              targets: buttons.map((button) => {
                const bounds = button.getBoundingClientRect();
                const extension = getComputedStyle(button, "::before");
                return {
                  width: Number.parseFloat(extension.width) || bounds.width,
                  height: Number.parseFloat(extension.height) || bounds.height,
                };
              }),
            };
          });
          expect((await group.boundingBox())?.height).toBe(restingHeight);
          expect(alignment.icons.length).toBeGreaterThan(0);
          for (const center of alignment.icons) {
            expect(Math.abs(center - alignment.time)).toBeLessThanOrEqual(1);
          }
          for (const target of alignment.targets) {
            expect(target.width).toBeGreaterThanOrEqual(44);
            expect(target.height).toBeGreaterThanOrEqual(44);
          }
          await tapBubble(group);
        }
      }

      await ownGroup.getByRole("button", { name: "Rewind", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      const ownReply = ownGroup.getByRole("button", { name: "Reply to message" });
      await expect(ownReply).toBeFocused();
      await expect(ownReply).toHaveCSS("outline-style", "solid");

      const footerOrder = await peerGroup
        .locator(".chat-group-footer")
        .locator("button, .chat-sender-name, .chat-group-timestamp")
        .evaluateAll((elements) =>
          elements.map((element) =>
            element.matches(".chat-sender-name")
              ? "name"
              : element.matches(".chat-group-timestamp")
                ? "time"
                : element.getAttribute("aria-label"),
          ),
        );
      expect(footerOrder).toEqual([
        "name",
        "time",
        "Reply to message",
        "Rewind",
        "Copy as markdown",
      ]);
    });
  });

  it("keeps refreshed self attribution through profile qualification and send reconciliation", async () => {
    await suite.withPage({ viewport: { height: 900, width: 860 } }, async ({ page }) => {
      const localSenderId = "c3e32452-0467-47e5-aafa-233cd5dae29f";
      const peerSenderId = "315ee057-302f-45b4-829d-2c5db1bfed75";
      const localAvatarUrl = `/api/users/${localSenderId}/avatar?v=7`;
      const localUser = { ...profile(localSenderId, "Collin Johnson"), avatarUrl: localAvatarUrl };
      const peerUser = profile(peerSenderId, "Riley Chen");
      const priorPrompt = "A prior attributed prompt.";
      const peerPrompt = "A peer attributed prompt.";
      const prompt = "A newly sent attributed prompt.";
      await page.route(`**/api/users/${localSenderId}/avatar*`, (route) =>
        route.fulfill({
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="purple"/></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        }),
      );
      await page.route(`**/api/users/${peerSenderId}/avatar*`, (route) =>
        route.fulfill({ status: 404, body: "No avatar" }),
      );
      const gateway = await installMockGateway(page, {
        historyMessages: [
          userMessage(localUser, [{ text: priorPrompt, type: "text" }], Date.now() - 3_000),
          userMessage(peerUser, [{ text: peerPrompt, type: "text" }], Date.now() - 2_000),
          assistant([{ text: "Ready for the next message.", type: "text" }], Date.now() - 1_000),
        ],
        presenceUsers: [
          {
            self: true,
            id: localSenderId,
            name: "Raw login",
            avatarUrl: localAvatarUrl,
          },
          peerUser,
        ],
      });

      const readUserAvatarLayout = async (message: string) => {
        const bubble = page.locator(".chat-group.user .chat-bubble", { hasText: message });
        await bubble.waitFor();
        return await bubble.evaluate((bubbleElement) => {
          const group = bubbleElement.closest<HTMLElement>(".chat-group.user");
          const avatar =
            group &&
            [...group.querySelectorAll<HTMLElement>(".chat-avatar")].find(
              (candidate) => getComputedStyle(candidate).display !== "none",
            );
          if (!group || !avatar) {
            throw new Error("Expected a visible attributed user avatar");
          }
          const bubbleRect = bubbleElement.getBoundingClientRect();
          const avatarRect = avatar.getBoundingClientRect();
          return {
            avatarLeft: avatarRect.left,
            avatarRight: avatarRect.right,
            bubbleLeft: bubbleRect.left,
            bubbleRight: bubbleRect.right,
            isPeer: group.classList.contains("chat-group--peer"),
          };
        });
      };

      await openChat(page);
      await page.getByText(priorPrompt, { exact: true }).waitFor();
      const connect = await gateway.waitForRequest("connect");
      const { client } = connect.params as { client: { instanceId: string } };
      await gateway.emitGatewayEvent("presence", {
        presence: [
          { instanceId: client.instanceId, user: localUser, ts: Date.now() },
          { instanceId: "peer-tab", user: peerUser, ts: Date.now() },
        ],
      });
      await expect(page.locator(".sidebar-identity-card")).toContainText(localUser.name);
      const before = await readUserAvatarLayout(priorPrompt);
      const peerBefore = await readUserAvatarLayout(peerPrompt);

      await send(page, prompt);
      const sendRequest = await gateway.waitForRequest("chat.send");
      const afterSend = await readUserAvatarLayout(prompt);
      const priorAfterSend = await readUserAvatarLayout(priorPrompt);
      const peerAfterSend = await readUserAvatarLayout(peerPrompt);

      const runId = readRunId(sendRequest.params, true);
      await gateway.emitChatFinal({ runId, text: "The attributed send completed." });
      await page
        .locator(".chat-thread .chat-bubble", { hasText: "The attributed send completed." })
        .waitFor();
      const afterFinal = await readUserAvatarLayout(prompt);

      for (const [phase, layout] of [
        ["initial history", before],
        ["optimistic send", afterSend],
        ["prior message after send", priorAfterSend],
        ["final response", afterFinal],
      ] as const) {
        expect(layout.isPeer, phase).toBe(false);
        expect(layout.avatarLeft, phase).toBeGreaterThanOrEqual(layout.bubbleRight + 9);
      }
      for (const [phase, layout] of [
        ["peer initial history", peerBefore],
        ["peer message after send", peerAfterSend],
      ] as const) {
        expect(layout.isPeer, phase).toBe(true);
        expect(layout.avatarRight, phase).toBeLessThanOrEqual(layout.bubbleLeft - 9);
      }
    });
  });

  it("keeps an attributed failed send in the transcript with one-line retry metadata", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const { gateway, request, group } = await deliveryFixture(
        page,
        "Keep my identity stable when delivery fails.",
      );
      const firstRunId = String((request.params as { idempotencyKey?: unknown }).idempotencyKey);
      await expect(group).toHaveClass(/\bchat-group--sender-tint\b/u);
      const background = () =>
        group
          .locator(".chat-bubble")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
      const sendingBackground = await background();

      await rejectDelivery(gateway);
      await expect
        .poll(() => page.locator(".chat-send-status, .chat-queue__item--failed").count())
        .toBeGreaterThan(0);

      await expect(group).toBeVisible();
      await expect(page.locator(".chat-queue__item--failed")).toHaveCount(0);
      await expect(page.locator(".chat-error")).toHaveCount(0);
      await expect(composer(page)).toHaveValue("");
      const status = group.locator(".chat-send-status");
      await expect(status.locator(".chat-send-status__discard")).toBeVisible();
      await expect(group.locator(".chat-sender-name")).toHaveCount(0);
      const footerLineCenters = await Promise.all(
        [
          status.getByText("Not sent", { exact: true }),
          status.getByRole("button", { name: "Retry queued message" }),
          status.getByRole("button", { name: "Discard", exact: true }),
        ].map((label) =>
          label.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top + rect.height / 2;
          }),
        ),
      );
      expect(footerLineCenters[0]).toBeCloseTo(footerLineCenters[1] ?? 0, 0);
      expect(footerLineCenters[0]).toBeCloseTo(footerLineCenters[2] ?? 0, 0);
      expect(await background()).toBe(sendingBackground);

      await gateway.deferNext("chat.send");
      await group.getByRole("button", { name: "Retry queued message" }).click();
      await expect(group.locator(".chat-send-status")).toHaveAttribute(
        "data-send-state",
        "sending",
      );
      await expect(group.getByRole("button", { name: "Retry queued message" })).toHaveCount(0);
      await expect(group).toBeVisible();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
      const sends = await gateway.getRequests("chat.send");
      const retryRunId = String(
        (sends[1]?.params as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
      );
      expect(retryRunId).not.toBe(firstRunId);
      await gateway.resolveDeferred("chat.send", { runId: retryRunId, status: "started" });
      await expect(group.locator(".chat-send-status")).toHaveCount(0);
    });
  });

  it("discards an attributed failed send from the transcript footer and preserves dismissal after reload", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const prompt = "Discard my failed send from the transcript.";
      const { gateway, group } = await deliveryFixture(page, prompt);
      await rejectDelivery(gateway);
      await expect(group.locator(".chat-send-status__discard")).toBeVisible();
      await page.reload();
      await page.locator(".chat-group.assistant").getByText(ready).waitFor();
      await expect(group.locator(".chat-send-status__discard")).toBeVisible();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await group.locator(".chat-send-status__discard").click();
      await expect(group).toHaveCount(0);
      await expect(page.locator(".chat-queue__item")).toHaveCount(0);

      await page.reload();
      await page.locator(".chat-group.assistant").getByText(ready).waitFor();
      await expect(page.locator(".chat-group.user", { hasText: prompt })).toHaveCount(0);
      await expect(page.locator(".chat-queue__item")).toHaveCount(0);
    });
  });

  it("keeps missing local-viewer avatar initials through a live rerender", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const prompt = "Please keep my fallback avatar readable.";
      const viewer = {
        ...profile("dd7c98e2-f51d-4590-b588-fa0682e165b7", "Hannah"),
        avatarUrl: "/api/users/dd7c98e2-f51d-4590-b588-fa0682e165b7/avatar?v=7",
      };
      const avatarRequests: Array<{ resourceType: string; url: string }> = [];
      await page.route(`**/api/users/${viewer.id}/avatar*`, async (route) => {
        const url = new URL(route.request().url());
        avatarRequests.push({
          resourceType: route.request().resourceType(),
          url: url.pathname + url.search,
        });
        await route.fulfill({
          body: JSON.stringify({ ok: false, error: { type: "not_found" } }),
          contentType: "application/json",
          status: 404,
        });
      });
      await installMockGateway(page, {
        presenceUsers: [
          {
            self: true,
            ...viewer,
            email: "hannah@example.test",
            watchedSessions: ["agent:main:main"],
          },
        ],
        historyMessages: [
          userMessage(viewer, prompt, Date.now() - 60_000, {
            senderProfileAvatarUrl: viewer.avatarUrl,
          }),
        ],
      });

      const avatarResponse = page.waitForResponse((response) =>
        response.url().endsWith(viewer.avatarUrl),
      );
      const [response] = await Promise.all([avatarResponse, openChat(page)]);
      expect(response.status()).toBe(404);
      await page.getByText(prompt).waitFor();

      const userGroup = page.locator(".chat-group.user", { hasText: prompt });
      const image = userGroup.locator("img.chat-avatar.user");
      const initials = userGroup.locator(".chat-avatar--sender-initials");
      expect(avatarRequests).toEqual([{ resourceType: "fetch", url: viewer.avatarUrl }]);
      await expect(userGroup.locator("img.chat-avatar.user[src]")).toHaveCount(0);
      await expect(initials).toBeVisible();
      await expect(initials).toHaveText("H");
      const originalImage = (await image.elementHandles())[0] ?? null;

      await userGroup.hover();
      await userGroup.getByRole("button", { name: "Reply to message" }).click();
      const replyPreview = page.locator(".chat-reply-preview");
      await replyPreview.waitFor({ state: "visible" });
      await expect(replyPreview.locator(".chat-reply-preview__text")).toHaveText(prompt);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(avatarRequests).toHaveLength(1);
      await expect(userGroup.locator("img.chat-avatar.user[src]")).toHaveCount(0);
      await expect(image).toBeHidden();
      // A settled miss may retain its first frame, but rerenders must not create more images.
      expect(
        await image.evaluateAll(
          (images, original) => images.every((candidate) => candidate === original),
          originalImage,
        ),
      ).toBe(true);
      await expect(initials).toBeVisible();
      await expect(initials).toHaveText("H");
    });
  });
});
