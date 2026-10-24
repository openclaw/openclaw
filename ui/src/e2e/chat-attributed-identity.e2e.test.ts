import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  defineMobileFooterActionCases,
  expectStableNamePosition,
  readActionTapArea,
  readFooterGeometry,
  sampleMetadataReveal,
} from "./chat-attributed-identity.test-support.ts";
import { requireRecord, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
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

  it.each([true, false])("keeps mobile attribution with a profile: %s", async (profiled) => {
    await suite.withPage(
      { viewport: { width: 932, height: 430 }, hasTouch: true },
      async ({ page, context }) => {
        const protocol = await context.newCDPSession(page);
        await protocol.send("Emulation.setSafeAreaInsetsOverride", {
          insets: { left: 44, right: 0, top: 0, bottom: 0 },
        });
        const morgan = profile("profile-morgan", "Morgan");
        const gateway = await installMockGateway(page, {
          presenceUsers: profiled ? [{ ...morgan, self: true }] : [],
          historyMessages: [
            userMessage(morgan, "Keep the phone transcript readable.", Date.now() - 20_000),
            assistant("A readable response.\n\n" + "A long response. ".repeat(300), Date.now()),
          ],
        });
        await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
        const messageWidth = "min(768px, 82%)";
        const widthInput = page.locator("[data-settings-chat-message-width]");
        await widthInput.fill(messageWidth);
        await widthInput.press("Tab");
        await expect
          .poll(() =>
            page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
              controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            ),
          )
          .toBe(messageWidth);
        await openChat(page);
        const transcript = page.locator(".chat-thread-inner");
        await transcript.getByText("A readable response.").waitFor();
        for (const direction of ["ltr", "rtl"]) {
          await page.evaluate((dir) => {
            document.documentElement.dir = dir;
          }, direction);
          for (const frame of [transcript, page.locator(".agent-chat__composer-shell")]) {
            const bounds = await frame.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(60);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(916);
            expect(bounds!.x - 44).toBeCloseTo(932 - bounds!.x - bounds!.width, 0);
          }
        }
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: mainSession,
          messageId: "mobile-peer-message",
          messageSeq: 5,
          message: userMessage(profile("profile-riley", "Riley"), "Riley joined.", Date.now()),
        });
        if (profiled) {
          const peer = page.locator(".chat-group--peer", { hasText: "Riley joined." });
          await expect(peer.locator(".chat-sender-name")).toHaveText("Riley");
          await expect(peer.locator(".chat-group-footer")).toHaveCSS("opacity", "1");
        } else {
          const own = page.locator(".chat-group.user", {
            hasText: "Keep the phone transcript readable.",
          });
          await expect(own).not.toHaveClass(/chat-group--peer/u);
          await expect(own).toHaveCSS("justify-content", "end");
        }
        const thread = page.locator(".chat-thread");
        await thread.focus();
        await thread.press("Home");
        await waitForChatScrollIdle(page);
        expect(await thread.evaluate((element) => element.scrollTop)).toBe(0);
        await thread.press("End");
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      },
    );
  });

  it("keeps author metadata stable through hover, focus, touch and rewind", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const own = profile("profile-riley", "Riley");
      const peer = profile("profile-alexandria", "Alexandria Montgomery-Winter");
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.rewind"],
        presenceUsers: [{ ...own, self: true }, peer],
        historyMessages: [
          userMessage(own, "Own message.", Date.now() - 30_000, { id: "own", seq: 1 }),
          assistant("Assistant message.\n\n".repeat(20), Date.now() - 20_000),
          assistant("Final assistant reply.", Date.now() - 15_000),
          userMessage(peer, "Long-name peer message.", Date.now() - 10_000, { id: "peer", seq: 4 }),
        ],
      });
      await openChat(page);
      const ownGroup = page.locator(".chat-group.user", { hasText: "Own message." });
      const peerGroup = page.locator(".chat-group.user", { hasText: "Long-name peer message." });
      const assistantGroup = page.locator(".chat-group.assistant");
      const intermediateId = await assistantGroup
        .locator(".chat-bubble")
        .first()
        .getAttribute("data-message-id");
      const intermediateOwner = assistantGroup.locator(
        `[data-message-actions-for="${intermediateId}"]`,
      );
      const inlineAction = intermediateOwner.locator("button").first();
      await expect(inlineAction).toHaveCount(1);
      const expectAssistantPresentation = (visible: boolean) =>
        expect
          .poll(async () =>
            Promise.all(
              [
                assistantGroup.locator(":scope > .chat-group-footer"),
                assistantGroup
                  .locator(":scope > .chat-group-footer .chat-group-footer-actions button")
                  .first(),
                inlineAction,
              ].map((node) =>
                node.evaluate((element) => {
                  const style = getComputedStyle(element);
                  return [style.opacity, style.pointerEvents];
                }),
              ),
            ),
          )
          .toEqual(
            Array.from({ length: 3 }, () => [visible ? "1" : "0", visible ? "auto" : "none"]),
          );
      await page.mouse.move(0, 0);
      await expectAssistantPresentation(false);
      await expect(peerGroup.locator(".chat-sender-name")).toHaveText(peer.name);
      await expect(page.locator(".chat-group-footer .chat-author-avatar")).toHaveCount(0);
      const details = peerGroup.locator(".chat-group-timestamp");
      const reply = peerGroup.getByRole("button", { name: "Reply to message" });
      for (const dir of ["ltr", "rtl"]) {
        await page.evaluate((direction) => {
          document.documentElement.dir = direction;
          document.body.tabIndex = -1;
          document.body.focus();
        }, dir);
        await page.mouse.move(0, 0);
        await expect(details).toHaveCSS("opacity", "0");
        const resting = await readFooterGeometry(peerGroup);
        await peerGroup.hover();
        await expect(details).toHaveCSS("opacity", "1");
        expectStableFooter(await readFooterGeometry(peerGroup), resting, dir === "rtl");
        await page.mouse.move(0, 0);
        await reply.focus();
        await expect(details).toHaveCSS("opacity", "1");
        expectStableFooter(await readFooterGeometry(peerGroup), resting, dir === "rtl");
        await expect(reply).toHaveCSS("opacity", "0.6");
      }
      await page.evaluate(() => {
        document.documentElement.dir = "ltr";
      });
      await page.setViewportSize({ height: 760, width: 390 });
      await expect(intermediateOwner).toHaveCount(1);
      await expect(assistantGroup.locator(".chat-message-actions-row")).toHaveCount(0);
      expect(await intermediateOwner.locator("..").getAttribute("class")).toContain(
        "chat-message-footer",
      );
      await expectAssistantPresentation(false);
      await assistantGroup
        .locator(".chat-bubble")
        .last()
        .dispatchEvent("pointerup", { button: 0, pointerType: "touch" });
      await expectAssistantPresentation(true);
      await page.getByRole("textbox", { name: "Chat composer" }).focus();
      await page.mouse.move(0, 0);
      const resting = await readFooterGeometry(peerGroup);
      await tapBubble(peerGroup);
      await expect(peerGroup).toHaveClass(/\bchat-group--meta-revealed\b/u);
      const revealed = await readFooterGeometry(peerGroup);
      expectStableFooter(revealed, resting);
      expect(revealed.actions.top).toBeLessThan(revealed.identity.bottom);
      expect(revealed.actions.bottom).toBeGreaterThan(revealed.identity.top);
      expect(revealed.actions.right).toBeCloseTo(revealed.footer.right, 0);
      expect(revealed.actions.left).toBeGreaterThanOrEqual(0);
      expect(revealed.footer.right).toBeLessThanOrEqual(390);
      const rewind = peerGroup.getByRole("button", { name: "Rewind", exact: true });
      const target = await readActionTapArea(rewind);
      expect(target.hitCorners).toBe(4);
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await page.mouse.click(target.left + 2, target.top + target.height - 2);
      const confirmation = page.locator(".chat-confirm-popover");
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      await tapBubble(peerGroup);
      await expect(peerGroup).not.toHaveClass(/\bchat-group--meta-revealed\b/u);
      await page.locator(".chat-thread").focus();
      await expect(page.locator(".agent-chat__composer-shell")).toHaveAttribute(
        "data-composer-editing",
        "false",
      );
      await waitForChatScrollIdle(page);
      for (const group of [ownGroup, peerGroup, assistantGroup]) {
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
      for (const group of [ownGroup, peerGroup]) {
        await tapBubble(group);
        const centers = await group.locator(".chat-group-footer").evaluate((footer) => {
          const center = (element: Element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.top + bounds.height / 2;
          };
          return {
            time: center(footer.querySelector(".chat-group-timestamp")!),
            icons: [...footer.querySelectorAll(".chat-group-footer-actions button svg")].map(
              center,
            ),
          };
        });
        expect(centers.icons.length).toBeGreaterThan(0);
        for (const icon of centers.icons) {
          expect(Math.abs(icon - centers.time)).toBeLessThanOrEqual(1);
        }
      }
      await page.setViewportSize({ height: 760, width: 1180 });
      await page.mouse.move(0, 0);
      const restingName = await ownGroup.locator(".chat-sender-name").boundingBox();
      await ownGroup.hover();
      expect((await ownGroup.locator(".chat-sender-name").boundingBox())?.x).toBe(restingName?.x);
      await ownGroup.getByRole("button", { name: "Rewind", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      const ownReply = ownGroup.getByRole("button", { name: "Reply to message" });
      await expect(ownReply).toBeFocused();
      await expect(ownReply).toHaveCSS("outline-style", "solid");
    });
  });

  it("keeps refreshed self attribution through profile qualification and send reconciliation", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const localUser = profile("c3e32452-0467-47e5-aafa-233cd5dae29f", "Collin Johnson");
      const peerUser = profile("315ee057-302f-45b4-829d-2c5db1bfed75", "Riley Chen");
      const priorPrompt = "A prior attributed prompt.";
      const peerPrompt = "A peer attributed prompt.";
      const prompt = "A newly sent attributed prompt.";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          userMessage(localUser, priorPrompt, Date.now() - 3_000),
          userMessage(peerUser, peerPrompt, Date.now() - 2_000),
          assistant("Ready for the next message.", Date.now() - 1_000),
        ],
        presenceUsers: [{ self: true, id: localUser.id, name: "Raw login" }, peerUser],
      });
      const expectAttribution = async (ownPrompts: string[]) => {
        for (const text of ownPrompts) {
          const own = page.locator(".chat-group.user", { hasText: text });
          await expect(own).toBeVisible();
          await expect(own).not.toHaveClass(/chat-group--peer/u);
        }
        await expect(page.locator(".chat-group.user", { hasText: peerPrompt })).toHaveClass(
          /chat-group--peer/u,
        );
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
      await expectAttribution([priorPrompt]);
      await send(page, prompt);
      const request = await gateway.waitForRequest("chat.send");
      await expectAttribution([priorPrompt, prompt]);
      await gateway.emitChatFinal({
        runId: readRunId(request.params, true),
        text: "The attributed send completed.",
      });
      await page.getByText("The attributed send completed.", { exact: true }).waitFor();
      await expectAttribution([priorPrompt, prompt]);
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
      await expect(group.locator(".chat-send-status")).toHaveCount(0);
      await expect(group).toBeVisible();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
      const sends = await gateway.getRequests("chat.send");
      const retryRunId = String(
        (sends[1]?.params as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
      );
      expect(retryRunId).not.toBe(firstRunId);
      await gateway.resolveDeferred("chat.send", { runId: retryRunId, status: "started" });
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
});
