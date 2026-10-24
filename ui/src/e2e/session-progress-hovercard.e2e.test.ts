import type { ProgressCard } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  pauseVirtualClock,
} from "./chat-flow.test-support.ts";
import {
  expectAttribute,
  expectCount,
  expectExactText,
  expectText,
  expectVisible,
} from "./sidebar-assertions.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

async function waitForPullRequestSubscription(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  sessionKey: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
      return requests.some((request) => {
        const sessionKeys = isRecord(request.params) ? request.params.sessionKeys : undefined;
        return Array.isArray(sessionKeys) && sessionKeys.includes(sessionKey);
      });
    })
    .toBe(true);
}

async function emitPullRequestSnapshot(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  sessionKey: string,
): Promise<void> {
  await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: {
      [sessionKey]: {
        pullRequests: [
          {
            branch: "steipete/session-hovercard-unify",
            number: 417,
            owner: "openclaw",
            repo: "openclaw",
            state: "open",
            title: "Restore the session hovercard with compact interactive attribution details",
            url: "https://github.com/openclaw/openclaw/pull/417",
          },
        ],
        rateLimited: false,
        status: "ready",
      },
    },
  });
}

function progressResponse(selectedSessionKey: string, card: ProgressCard) {
  return {
    cases: [
      { match: { sessionKey: selectedSessionKey }, response: { card: null } },
      { match: { sessionKey: card.sessionKey }, response: { card } },
    ],
  };
}

const previewRow = (key: string, label: string, updatedAt: number) => ({
  key,
  kind: "direct",
  label,
  updatedAt,
});
const suite = createChatFlowE2eSuite();
function withHoverPage(run: (fixture: { page: Page }) => Promise<void>, dark = false) {
  return suite.withPage(
    {
      hasTouch: false,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(dark ? { colorScheme: "dark" as const } : {}),
    },
    run,
  );
}

suite.define(() => {
  it("renders safe progress markdown and refreshes the hovered card after a change event", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:selected";
    const sessionKey = "agent:main:other-session";
    const participants: SessionParticipant[] = [
      { identity: { type: "profile", id: "profile-ada" }, label: "Ada King" },
      { identity: { type: "profile", id: "profile-self" }, label: "You" },
      { identity: { type: "profile", id: "profile-mira" }, label: "Mira" },
      { identity: { type: "profile", id: "profile-riley" }, label: "Riley" },
      { identity: { type: "profile", id: "profile-sam" }, label: "Sam" },
      { identity: { type: "profile", id: "profile-lee" }, label: "Lee" },
    ];
    const initialMarkdown = [
      "**Building** phase 2",
      "",
      '<progress value="3" max="7"></progress>',
      "",
      "| step | state |",
      "| --- | --- |",
      "| tests | green |",
      "",
      '<span onclick="window.__progressCardPwned = true">unsafe</span>',
      "<script>window.__progressCardPwned = true</script>",
    ].join("\n");

    await withHoverPage(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
      });
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "progressCard.get",
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        ],
        presenceUsers: [
          { self: true, id: "profile-self", name: "You" },
          { id: "profile-mira", name: "Mira" },
          { id: "profile-riley", name: "Riley" },
          { id: "profile-ada", name: "Ada King" },
        ],
        historyMessages: [
          {
            role: "assistant",
            timestamp: now - 30 * 60_000,
            content: [{ type: "text", text: `Follow progress in ${sessionKey}.` }],
          },
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "progressCard.get": progressResponse(selectedSessionKey, {
            markdown: initialMarkdown,
            revision: 1,
            sessionKey,
            steps: [
              { step: "Inspect", status: "completed" },
              { step: "Package", status: "in_progress" },
              { step: "Publish", status: "pending" },
            ],
            updatedAt: now - 15 * 60_000,
          }),
          "sessions.list": chatSessionListResponse([
            previewRow(selectedSessionKey, "Selected session", now - 5 * 60_000),
            {
              createdActor: {
                type: "human",
                id: "profile-ada",
                label: "Ada King",
                identity: { type: "profile", id: "profile-ada" },
              },

              key: sessionKey,
              kind: "direct",
              label: "Other session",
              displayName: "Other session",
              participants: participants.slice(0, 4),
              expandedParticipants: participants,
              participantCount: 6,

              updatedAt: now - 21 * 24 * 60 * 60_000,
            },
          ]),
        },
        sessionKey: selectedSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
      await selectAllSidebarSessions(page);

      const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      await row.waitFor({ state: "visible" });
      await row.hover();
      const card = page.locator(".session-progress-hovercard");
      await waitForPullRequestSubscription(gateway, sessionKey);
      await emitPullRequestSnapshot(gateway, sessionKey);

      await card.waitFor({ state: "visible" });
      expect(["left", "right"]).toContain(await card.getAttribute("data-side"));
      await expectExactText(card.locator(".session-hovercard__title"), "Other session");
      await expectExactText(card.locator(".session-hovercard__plan-step"), "Package");
      expect(await card.locator(".session-hovercard__plan-count").textContent()).toBe("1/3");
      await expectCount(card.locator(".session-hovercard__pr-row"), 1);
      const prRow = card.locator(".session-hovercard__pr-row").first();
      const prTitle = prRow.locator(".session-hovercard__pr-title");
      const fullPrTitle =
        "Restore the session hovercard with compact interactive attribution details";
      await expectExactText(prTitle, fullPrTitle);

      expect(await prRow.getAttribute("aria-label")).toContain(fullPrTitle);

      expect(
        await prTitle.evaluate((node) => ({
          clamp: getComputedStyle(node).webkitLineClamp,
          whiteSpace: getComputedStyle(node).whiteSpace,
        })),
      ).toEqual({ clamp: "2", whiteSpace: "normal" });
      // The row is an anchor: a dropped text-decoration reset is invisible to jsdom.
      await expect
        .poll(() => prRow.evaluate((node) => getComputedStyle(node).textDecorationLine))
        .toBe("none");
      const restingBackground = await prRow.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      await prRow.hover();
      await expect
        .poll(() => prRow.evaluate((node) => getComputedStyle(node).backgroundColor))
        .not.toBe(restingBackground);

      const attribution = card.locator(".session-hovercard__attribution");
      const attributionName = attribution.locator("a.session-hovercard__attribution-name");
      expect(await attributionName.getAttribute("href")).toBe("/activity/profile-ada");
      const linkedAvatars = attribution.locator(".person-activity-avatar-link .viewer-avatar");
      await expectCount(linkedAvatars, 5);
      const collapsedSpread = await linkedAvatars.evaluateAll((avatars) => {
        const left = avatars.map((avatar) => avatar.getBoundingClientRect().left);
        return left.at(-1)! - left[0]!;
      });
      await attributionName.hover();
      await expect
        .poll(async () => {
          const left = await linkedAvatars.evaluateAll((avatars) =>
            avatars.map((avatar) => avatar.getBoundingClientRect().left),
          );
          return left.at(-1)! - left[0]!;
        })
        .toBeGreaterThan(collapsedSpread + 5);

      const otherParticipants = attribution.locator(".session-hovercard__attribution-others");
      await otherParticipants.hover();
      const participantMenu = attribution.locator(".session-hovercard__participant-menu");
      await expectVisible(participantMenu, true);
      expect(
        await participantMenu.locator("a.session-hovercard__participant-link").allTextContents(),
      ).toEqual(["Mira", "Riley", "Sam", "Lee"]);

      await expectText(card.locator("strong"), "Building");

      const notepad = card.locator(".session-hovercard__notepad");

      const markdown = notepad.locator(".session-progress-card__markdown");
      expect(await markdown.locator(":scope > :first-child").getAttribute("class")).toContain(
        "session-progress-card__progress",
      );

      const progress = markdown.locator("progress");
      await expectAttribute(progress, "value", "3");
      expect(await progress.getAttribute("max")).toBe("7");
      expect(await progress.getAttribute("aria-label")).toBe("Progress · 3/7");
      expect(await card.locator("table").count()).toBe(1);

      expect(await card.locator("script").count()).toBe(0);
      expect(await card.locator("[onclick]").count()).toBe(0);
      expect(await card.textContent()).not.toContain("progressCardPwned");

      expect(
        await card
          .locator(".session-hovercard__section")
          .evaluateAll((sections) =>
            sections.every((section) => getComputedStyle(section).borderTopWidth === "0px"),
          ),
      ).toBe(true);
      await prRow.hover();
      await prRow.evaluate((node) => {
        node.addEventListener(
          "click",
          (event) => {
            event.preventDefault();
            (
              window as unknown as { sessionHovercardPrClicked?: boolean }
            ).sessionHovercardPrClicked = true;
          },
          { once: true },
        );
      });
      await prRow.click();
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { sessionHovercardPrClicked?: boolean })
              .sessionHovercardPrClicked,
        ),
      ).toBe(true);
      expect(await page.evaluate(() => "__progressCardPwned" in window)).toBe(false);

      const link = page.locator(
        `.chat-thread a.markdown-session-link[data-session-key="${sessionKey}"]`,
      );
      await link.waitFor({ state: "visible" });
      await expectExactText(link, "Other session");
      expect(await link.getAttribute("href")).toBe("/chat/main/other-session");
      await link.hover();
      await card.waitFor({ state: "visible" });
      await waitForPullRequestSubscription(gateway, sessionKey);
      await emitPullRequestSnapshot(gateway, sessionKey);
      await expect
        .poll(async () => ["bottom", "top"].includes((await card.getAttribute("data-side")) ?? ""))
        .toBe(true);
      await expectExactText(card.locator(".session-hovercard__title"), "Other session");
      await expectExactText(card.locator(".session-hovercard__pr-title").first(), fullPrTitle);
      await expectText(card.locator("strong"), "Building");

      const progressReads = async () =>
        (await gateway.getRequests("progressCard.get", { sessionKey })).length;
      await gateway.deferNext("progressCard.get", { sessionKey });
      await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });
      await expect.poll(progressReads).toBe(2);
      await gateway.rejectDeferred("progressCard.get", {
        code: "UNAVAILABLE",
        message: "temporary refresh failure",
        retryable: true,
      });
      await expectText(card.locator("strong"), "Building");
      await expectAttribute(card.locator("progress"), "value", "3");

      await gateway.setMethodResponse(
        "progressCard.get",
        progressResponse(selectedSessionKey, {
          markdown: '**Packaging** phase 3\n\n<progress value="6" max="7"></progress>',
          revision: 2,
          sessionKey,
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Package", status: "completed" },
            { step: "Publish", status: "in_progress" },
          ],
          updatedAt: now,
        }),
      );
      await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });

      await expectText(card, "Packaging");
      await expectAttribute(card.locator("progress"), "value", "6");
      await expectExactText(card.locator(".session-hovercard__plan-step"), "Publish");
      expect(await card.locator(".session-hovercard__plan-count").textContent()).toBe("2/3");
      await expect.poll(progressReads).toBe(3);
    }, true);
  });

  it("honors cold, bridge, sweep, and menu-suppression timing on real sidebar rows", async () => {
    const selectedSessionKey = "agent:main:timing-selected";
    const firstSessionKey = "agent:main:timing-first";
    const secondSessionKey = "agent:main:timing-second";

    await withHoverPage(async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      // Browser RPC time must not consume the hover-delay assertion windows.
      await page.clock.install();
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        methodResponses: {
          "progressCard.get": { card: null },
          "sessions.list": chatSessionListResponse([
            previewRow(selectedSessionKey, "Selected", 3),
            previewRow(firstSessionKey, "First timing row", 2),
            previewRow(secondSessionKey, "Second timing row", 1),
          ]),
        },
        sessionKey: selectedSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
      const first = el(`[data-session-key="${firstSessionKey}"]`);
      const second = el(`[data-session-key="${secondSessionKey}"]`);
      const card = el(".session-progress-hovercard");
      await first.waitFor({ state: "visible" });
      expect(
        await page.evaluate(
          () => customElements.get("openclaw-session-progress-hovercard-provider") === undefined,
        ),
      ).toBe(true);
      await pauseVirtualClock(page);

      const pointer = async (
        locator: typeof first,
        type: "pointerover" | "pointerout",
        coordinates: { clientX?: number; clientY?: number } = {},
      ) =>
        locator.dispatchEvent(type, {
          bubbles: true,
          composed: true,
          ...coordinates,
          pointerType: "mouse",
          relatedTarget: null,
        });

      await first.hover();
      await expectAttribute(first, "aria-haspopup", "dialog");
      expect(await card.count()).toBe(0);
      await page.clock.runFor(449);
      expect(await card.count()).toBe(0);
      await page.clock.runFor(1);
      await card.waitFor({ state: "visible" });
      const firstBounds = await first.boundingBox();
      expect(firstBounds).not.toBeNull();
      const cardBounds = await card.boundingBox();
      expect(cardBounds).not.toBeNull();
      await pointer(first, "pointerout", {
        // A clamped card can sit diagonally from its row, so the pointer may
        // leave through the row's top edge even while moving toward the card.
        clientX: (firstBounds?.x ?? 0) + (firstBounds?.width ?? 0) / 2,
        clientY: firstBounds?.y ?? 0,
      });
      await page.clock.runFor(101);
      expect(await card.getAttribute("data-open")).toBe("true");
      await page.clock.runFor(118);
      await page.mouse.move(
        (cardBounds?.x ?? 0) + (cardBounds?.width ?? 0) / 2,
        (cardBounds?.y ?? 0) + (cardBounds?.height ?? 0) / 2,
      );
      await page.clock.runFor(1);
      expect(await card.count()).toBe(1);
      await page.mouse.move(900, 800);
      await page.clock.runFor(99);
      expect(await card.count()).toBe(1);
      await page.clock.runFor(1);
      expect(
        await card.evaluateAll((cards) =>
          cards.every((element) => element.getAttribute("data-open") === "false"),
        ),
      ).toBe(true);
      await page.clock.runFor(300);
      expect(await card.count()).toBe(0);

      await first.hover();
      await first.locator("a.sidebar-recent-session__link").focus();
      await page.clock.runFor(1);
      await card.waitFor({ state: "visible" });
      await expectExactText(card.locator(".session-hovercard__title"), "First timing row");
      await page.keyboard.press("Escape");
      await expectCount(card, 0);
      await page.mouse.move(900, 800);
      await page.clock.runFor(300);

      await first.hover();
      expect(await card.count()).toBe(0);
      await page.clock.runFor(449);
      expect(await card.count()).toBe(0);
      await page.clock.runFor(1);
      await card.waitFor({ state: "visible" });

      await second.hover();
      await page.clock.runFor(79);
      expect(await card.locator(".session-hovercard__title").textContent()).toBe(
        "First timing row",
      );
      await page.clock.runFor(1);
      expect(await card.locator(".session-hovercard__title").textContent()).toBe(
        "Second timing row",
      );

      await card.hover();
      expect(await card.count()).toBe(1);
      await page.mouse.move(900, 800);
      await page.clock.runFor(100);
      await page.clock.runFor(300);
      expect(await card.count()).toBe(0);

      for (const source of ["pointer", "keyboard"]) {
        await first.hover();
        await page.clock.runFor(450);
        await card.waitFor({ state: "visible" });
        if (source === "pointer") {
          await first.click({ button: "right" });
        } else {
          await first.locator(".sidebar-recent-session__link").focus();
          await page.keyboard.press("Shift+F10");
        }
        await expectCount(card, 0);
        await expect
          .poll(() => el("openclaw-session-menu").getByRole("menuitem").count())
          .toBeGreaterThan(0);
        await second.dispatchEvent("pointerover", { pointerType: "mouse" });
        await page.clock.runFor(500);
        expect(await card.count()).toBe(0);
        await page.keyboard.press("Escape");
        await page.mouse.move(900, 800);
        await page.clock.runFor(300);
      }
    });
  });

  it("refreshes a held avatar after Gateway authentication reconnects", async () => {
    const sessionKey = "agent:main:avatar-auth-reconnect";
    const lastMessagePreview = "Finished <strong>without markup</strong>.";
    const channelAvatarUrl = `/__openclaw__/channel-avatar/${encodeURIComponent(sessionKey)}`;

    await withHoverPage(async ({ page }) => {
      let avatarAvailable = false;
      let rejectedAvatarRequests = 0;
      await page.route(`**${channelAvatarUrl}`, async (route) => {
        expect(await route.request().headerValue("authorization")).toBe("Bearer e2e-device-token");
        if (!avatarAvailable) {
          await route.fulfill({ status: 401 });
          rejectedAvatarRequests += 1;
          return;
        }
        await route.fulfill({
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#b84cff"/><circle cx="24" cy="27" r="5" fill="white"/><circle cx="43" cy="27" r="5" fill="white"/><path d="M19 43c8 6 19 6 27 0" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        });
      });
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        methodResponses: {
          "progressCard.get": { card: null },
          "sessions.list": chatSessionListResponse([
            {
              channelAvatarUrl,
              createdActor: {
                type: "human",
                id: "profile-ada",
                label: "Ada King",
                identity: { type: "profile", id: "profile-ada" },
              },
              key: sessionKey,
              kind: "direct",
              label: "Avatar reconnect",
              lastMessagePreview,
              updatedAt: 1,
            },
          ]),
        },
        sessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      await row.waitFor({ state: "visible" });
      await row.hover();
      const card = page.locator(".session-progress-hovercard");
      await card.waitFor({ state: "visible" });
      const cardId = await card.getAttribute("id");
      expect(await row.getAttribute("title")).toBeNull();
      expect(await row.locator(".sidebar-recent-session__link").getAttribute("title")).toBeNull();
      expect(await card.locator("openclaw-viewer-avatar").count()).toBe(0);
      await expectExactText(card.locator(".session-hovercard__excerpt"), lastMessagePreview);
      expect(await card.locator(".session-hovercard__excerpt strong").count()).toBe(0);
      expect(await card.locator(".session-progress-card").count()).toBe(0);
      expect(
        await card
          .locator(".session-hovercard__excerpt")
          .evaluate((element) => getComputedStyle(element).webkitLineClamp),
      ).toBe("2");
      const avatar = card.locator("openclaw-channel-avatar.session-hovercard__creator-avatar");
      const fallback = avatar.locator(".session-hovercard__creator-avatar-fallback");
      await expectExactText(fallback, "AK");
      expect(await fallback.isVisible()).toBe(true);
      expect(await avatar.locator("img.channel-avatar").count()).toBe(0);

      await expect.poll(() => rejectedAvatarRequests).toBeGreaterThan(0);
      avatarAvailable = true;
      await reconnectMockGateway(page, gateway);

      await expectCount(avatar.locator("img.channel-avatar"), 1);
      await expect
        .poll(() =>
          avatar.locator("img.channel-avatar").evaluate((image: HTMLImageElement) => ({
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
          })),
        )
        .toEqual({ complete: true, naturalWidth: 64, naturalHeight: 64 });
      expect(await fallback.count()).toBe(1);
      expect(await fallback.isVisible()).toBe(false);
      expect(await card.getAttribute("id")).toBe(cardId);
      expect(await card.evaluate((element) => element.outerHTML)).not.toContain("e2e-device-token");
    });
  });
});
