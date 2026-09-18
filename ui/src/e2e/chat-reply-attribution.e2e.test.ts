import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Reply attribution" });
const sessionKey = "agent:main:reply-attribution";
const prompt = {
  role: "user",
  content: "Please review **the release checklist** and the remaining tasks.",
  timestamp: 1_800_000_000_000,
  __openclaw: { id: "original", seq: 1, senderId: "alice", senderName: "Alice Chen" },
};
const messages = [
  prompt,
  {
    role: "assistant",
    content: "The first answer.",
    timestamp: 1_800_000_001_000,
    __openclaw: { id: "first-answer", seq: 2 },
  },
  {
    role: "assistant",
    content: "The second answer.",
    timestamp: 1_800_000_002_000,
    __openclaw: { id: "second-answer", seq: 3 },
  },
  {
    role: "user",
    content: "Thanks!",
    timestamp: 1_800_000_003_000,
    __openclaw: { id: "second-user", seq: 4, senderId: "jordan", senderName: "Jordan Lee" },
  },
  {
    role: "assistant",
    content: "A forwarded update.",
    timestamp: 1_800_000_004_000,
    senderSession: { sessionKey: "agent:main:main", agentId: "main" },
    __openclaw: { id: "forwarded", seq: 5 },
  },
  ...Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `Conversation entry ${i + 1}.`,
    timestamp: 1_800_000_005_000 + i * 1000,
    __openclaw: { id: `filler-${i}`, seq: 6 + i },
  })),
  {
    role: "assistant",
    content: "Returning to the first question.",
    timestamp: 1_800_000_014_000,
    __openclaw: { id: "explicit-answer", seq: 15, replyToId: "original" },
  },
  {
    role: "assistant",
    content: "An answer to an unavailable prompt.",
    timestamp: 1_800_000_015_000,
    __openclaw: {
      id: "unavailable-answer",
      seq: 16,
      replyToId: "unavailable",
      replyToPreview: { senderLabel: "Jordan Lee", text: "Earlier release question" },
    },
  },
  {
    role: "user",
    content: [
      {
        type: "attachment",
        attachment: {
          kind: "document",
          url: "https://files.example.test/release-plan.pdf",
          label: "release-plan.pdf",
          mimeType: "application/pdf",
        },
      },
    ],
    timestamp: 1_800_000_016_000,
    __openclaw: { id: "document", seq: 17, senderId: "alice", senderName: "Alice Chen" },
  },
  {
    role: "assistant",
    content: "I reviewed the release plan.",
    timestamp: 1_800_000_017_000,
    __openclaw: { id: "document-answer", seq: 18, replyToId: "document" },
  },
  {
    role: "assistant",
    content: "I can continue with the remaining context.",
    timestamp: 1_800_000_018_000,
    __openclaw: {
      id: "missing-answer",
      seq: 19,
      replyToId: "missing",
      replyToPreview: { senderLabel: "Jordan Lee", text: "" },
    },
  },
];

suite.define(() => {
  it.each([
    ...["light", "dark"].flatMap((theme) =>
      [1440, 390, 360].flatMap((width) =>
        [1, 2, 5].map((messageCount) => ({ theme, width, messageCount, nameLength: "short" })),
      ),
    ),
    { theme: "light", width: 390, messageCount: 1, nameLength: "long" },
  ])(
    "keeps $messageCount replies aligned and navigable with a $nameLength name in $theme at $width",
    async ({ theme, width, messageCount, nameLength }) => {
      const senderName = nameLength === "long" ? "Casey Morgan ".repeat(80).trim() : "Alice Chen";
      const { __openclaw: promptMetadata } = prompt;
      await suite.withPage(
        { viewport: { width, height: 900 }, locale: "en-US" },
        async ({ page }) => {
          await installMockGateway(page, {
            sessionKey,
            historyMessages: [
              {
                role: "assistant",
                content: "The release workspace is ready.",
                __openclaw: { id: "welcome-1" },
              },
              {
                role: "assistant",
                content: "The notes are available.",
                __openclaw: { id: "welcome-2" },
              },
              { ...prompt, __openclaw: { ...promptMetadata, senderName } },
              ...Array.from({ length: messageCount }, (_, index) => ({
                ...messages[1],
                content: `Answer paragraph ${index + 1}.`,
                __openclaw: { id: index === 0 ? "first-answer" : `answer-${index}` },
              })),
              ...messages.slice(3),
            ].map(({ __openclaw: metadata, ...message }, index) =>
              Object.assign(message, {
                timestamp: 1_800_000_000_000 + index * 1000,
                __openclaw: Object.assign({}, metadata, { seq: index + 1 }),
              }),
            ),
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const row = page.locator(
            '.chat-group:has([data-entry-id="explicit-answer"]) .chat-reply-attribution--reply',
          );
          await row.waitFor();
          await page.evaluate((selectedTheme) => {
            document.documentElement.dataset.themeMode = selectedTheme;
          }, theme);
          await page.evaluate(() => document.fonts.ready);
          await page.locator(".chat-thread").evaluate((el) => el.scrollTo({ top: 0 }));
          const firstGroup = page.locator('.chat-group:has([data-entry-id="first-answer"])');
          await firstGroup.waitFor();
          expect(await firstGroup.locator(".chat-reply-attribution--reply").count()).toBe(1);
          expect(await firstGroup.locator(".chat-bubble").count()).toBe(messageCount);
          const firstAvatar = await firstGroup.evaluate((group) => {
            const avatar = group.querySelector(
              ":scope > .chat-avatar, :scope > .chat-avatar-slot",
            )!;
            const content = group.querySelector(".chat-bubble > .chat-text")!;
            const identity = avatar.getBoundingClientRect();
            return {
              offset: identity.top - content.getBoundingClientRect().top,
              width: identity.width,
            };
          });
          if (width < 768) {
            expect(firstAvatar.width).toBe(0);
          } else {
            expect(Math.abs(firstAvatar.offset)).toBeLessThanOrEqual(1);
          }
          const excerptText = firstGroup.locator(".chat-reply-attribution__excerpt-text");
          expect(await excerptText.textContent()).toBe(
            "Please review the release checklist and the remaining tasks.",
          );
          expect(
            await firstGroup.locator(".chat-reply-attribution--reply").textContent(),
          ).not.toMatch(/[“”·…]/);
          const unattributed = page.locator(".chat-group.assistant").first();
          expect(await unattributed.locator(".chat-reply-attribution--reply").count()).toBe(0);
          expect(
            await unattributed
              .locator(":scope > .chat-avatar, :scope > .chat-avatar-slot")
              .evaluate((avatar) => getComputedStyle(avatar).alignSelf),
          ).toBe("flex-end");
          const footerGaps = await page.evaluate(() =>
            ["first-answer", "welcome-2"].map((id) => {
              const group = document
                .querySelector(`[data-entry-id="${id}"]`)!
                .closest(".chat-group")!;
              const paragraphs = group.querySelectorAll(".chat-bubble .chat-text > p");
              const lastParagraph = paragraphs[paragraphs.length - 1]!;
              const meta = group.querySelector(
                ":scope > .chat-group-footer .chat-group-footer__meta",
              )!;
              return (
                meta.getBoundingClientRect().top - lastParagraph.getBoundingClientRect().bottom
              );
            }),
          );
          expect(Math.abs(footerGaps[0]! - footerGaps[1]!)).toBeLessThanOrEqual(0.1);
          const from = page.locator(".chat-group--forwarded .chat-reply-attribution");
          const fromGeometry = await from.evaluate((el) => ({
            font: getComputedStyle(el).fontSize,
            height: el.getBoundingClientRect().height,
          }));
          await page
            .locator(".chat-thread")
            .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
          await row.waitFor();
          expect(await row.locator(".chat-reply-attribution__name").textContent()).toBe(senderName);
          const unavailable = page.locator(
            '.chat-group:has([data-entry-id="unavailable-answer"]) .chat-reply-attribution--reply',
          );
          expect(await unavailable.textContent()).toContain("Earlier release question");
          expect(await unavailable.locator("button, a").count()).toBe(0);
          const missing = page.locator(
            '.chat-group:has([data-entry-id="missing-answer"]) .chat-reply-attribution--reply',
          );
          expect(await missing.textContent()).toContain("Jordan Lee");
          expect(await missing.locator(".chat-reply-attribution__unavailable").textContent()).toBe(
            "Original message unavailable",
          );
          expect(await missing.locator("button, a").count()).toBe(0);
          const documentRow = page.locator(
            '.chat-group:has([data-entry-id="document-answer"]) .chat-reply-attribution--reply',
          );
          expect(await documentRow.locator(".chat-reply-attribution__file svg").count()).toBe(1);
          expect((await documentRow.locator("button").textContent())?.trim()).toBe(
            "release-plan.pdf",
          );
          await row.scrollIntoViewIfNeeded();
          const geometry = await row.evaluate((el) => {
            const avatar = el.querySelector(".chat-author-avatar")!.getBoundingClientRect();
            const name = el.querySelector(".chat-reply-attribution__name")!.getBoundingClientRect();
            return {
              font: getComputedStyle(el).fontSize,
              height: el.getBoundingClientRect().height,
              avatar: avatar.height,
              gap: name.left - avatar.right,
              center: name.top + name.height / 2 - (avatar.top + avatar.height / 2),
              overflow: el.scrollWidth - el.clientWidth,
              outsideGroup:
                el.getBoundingClientRect().right - el.parentElement!.getBoundingClientRect().right,
            };
          });
          expect(geometry.font).toBe("13px");
          expect(fromGeometry.font).toBe("12px");
          expect(geometry.avatar).toBe(16);
          expect(geometry.gap).toBe(4);
          expect(Math.abs(geometry.center)).toBeLessThanOrEqual(1);
          expect(geometry.overflow).toBeLessThanOrEqual(1);
          expect(geometry.outsideGroup).toBeLessThanOrEqual(1);
          if (width < 768) {
            const mobile = await row.evaluate((element) => {
              const group = element.closest(".chat-group")!;
              const bounds = group.getBoundingClientRect();
              const rowBounds = element.getBoundingClientRect();
              const content = group.querySelector(".chat-bubble")!.getBoundingClientRect();
              return {
                speakerWidth: group
                  .querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!
                  .getBoundingClientRect().width,
                connectorWidth: group
                  .querySelector(".chat-reply-connector")!
                  .getBoundingClientRect().width,
                iconWidth: element
                  .querySelector(".chat-reply-attribution__mobile-icon")!
                  .getBoundingClientRect().width,
                start: rowBounds.left - bounds.left,
                gap: content.top - rowBounds.bottom,
              };
            });
            expect(mobile.speakerWidth).toBe(0);
            expect(mobile.connectorWidth).toBe(0);
            expect(mobile.iconWidth).toBe(14);
            expect(mobile.start).toBeCloseTo(0, 1);
            expect(mobile.gap).toBeCloseTo(6, 1);
          } else {
            const replyGroup = row.locator("..").locator("..");
            const connector = replyGroup.locator(".chat-reply-connector path");
            await expect.poll(() => connector.getAttribute("d")).toBeTruthy();
            const connection = await connector.evaluate((element) => {
              const path = element as SVGPathElement;
              const group = path.closest(".chat-group")!;
              const avatar = group
                .querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!
                .getBoundingClientRect();
              const svg = path.ownerSVGElement!.getBoundingClientRect();
              const label = group
                .querySelector(".chat-reply-attribution__label")!
                .getBoundingClientRect();
              const start = path.getPointAtLength(0),
                end = path.getPointAtLength(path.getTotalLength());
              return {
                startX: svg.left + start.x,
                startY: svg.top + start.y,
                avatarX: avatar.left + avatar.width / 2,
                avatarY: avatar.top + avatar.height / 2,
                endY: svg.top + end.y,
                labelY: label.top + label.height / 2,
              };
            });
            expect(Math.abs(connection.startX - connection.avatarX)).toBeLessThanOrEqual(1);
            expect(Math.abs(connection.startY - connection.avatarY)).toBeLessThanOrEqual(1);
            expect(Math.abs(connection.endY - connection.labelY)).toBeLessThanOrEqual(1);
          }
          for (const activation of ["click", "Enter"]) {
            await page
              .locator(".chat-thread")
              .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
            await row.waitFor();
            const excerpt = row.locator("button");
            await excerpt.scrollIntoViewIfNeeded();
            expect(await excerpt.isVisible()).toBe(true);
            expect(await excerpt.getAttribute("title")).toBeNull();
            await excerpt.hover();
            await excerpt.focus();
            expect(await page.locator('[role="tooltip"]:visible').count()).toBe(0);
            const before = await page.locator(".chat-thread").evaluate((el) => el.scrollTop);
            if (activation === "click") {
              await excerpt.click();
            } else {
              await excerpt.focus();
              await excerpt.press("Enter");
            }
            const original = page.locator('[data-entry-id="original"]');
            await expect
              .poll(() => original.getAttribute("class"))
              .toContain("chat-bubble--reply-target");
            await expect
              .poll(() => page.locator(".chat-thread").evaluate((el) => el.scrollTop))
              .toBeLessThan(before);
            await expect
              .poll(() => original.getAttribute("class"))
              .not.toContain("chat-bubble--reply-target");
          }
        },
      );
    },
  );

  it.each(
    ["light", "dark"].flatMap((theme) => [390, 360, 1440].map((width) => ({ theme, width }))),
  )(
    "keeps self quotes inside and peer quotes above their own bubbles with native gaps in $theme at $width",
    async ({ theme, width }) => {
      await suite.withPage(
        { viewport: { width, height: 1000 }, locale: "en-US", hasTouch: width < 768 },
        async ({ page }) => {
          const self = {
            senderId: "alice",
            senderName: "Alice Chen",
            senderIdentity: { type: "profile", id: "alice" },
          };
          const peer = {
            senderId: "jordan",
            senderName: "Jordan Lee",
            senderIdentity: { type: "profile", id: "jordan" },
          };
          const longQuote =
            "Review the release checklist, ownership, rollback procedure, and the remaining verification steps before the deployment.";
          const inlineMessages = [
            {
              role: "assistant",
              content: longQuote,
              __openclaw: {
                id: "inline-agent",
                senderId: "main",
                senderName: "OpenClaw",
              },
            },
            {
              role: "user",
              content: "Please keep the canary running.",
              __openclaw: { id: "inline-self", ...self },
            },
            ...["OK", "I will review the checklist today."].flatMap((content, index) => [
              { role: "user", content, __openclaw: { id: `plain-${index}`, ...self } },
              {
                role: "user",
                content,
                __openclaw: { id: `quoted-${index}`, ...self, replyToId: "inline-agent" },
              },
            ]),
            {
              role: "user",
              content: "I will watch the canary metrics.",
              __openclaw: { id: "peer-reply", ...peer, replyToId: "inline-self" },
            },
            {
              role: "user",
              content: "OK",
              __openclaw: {
                id: "peer-short",
                ...peer,
                replyToId: "retained-source",
                replyToPreview: { senderLabel: "OpenClaw", text: longQuote },
              },
            },
            {
              role: "user",
              content: [
                {
                  type: "image",
                  url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Crect width='160' height='90' fill='teal'/%3E%3C/svg%3E",
                  fileName: "stack-preview.svg",
                },
              ],
              __openclaw: { id: "peer-image", ...peer },
            },
            {
              role: "user",
              content: "The peer stack ends here.",
              __openclaw: { id: "peer-last", ...peer },
            },
            {
              role: "user",
              content: "Please continue without the old message.",
              __openclaw: {
                id: "inline-missing",
                ...self,
                replyToId: "missing-source",
                replyToPreview: { senderLabel: "Jordan Lee", text: "" },
              },
            },
          ];
          inlineMessages.forEach((message, index) => {
            Object.assign(message, { timestamp: 1_800_000_000_000 + index * 1000 });
            Object.assign(message["__openclaw"], { seq: index + 1 });
          });
          await installMockGateway(page, {
            sessionKey,
            presenceUsers: [
              {
                self: true,
                id: "alice",
                identity: { type: "profile", id: "alice" },
                name: "Alice Chen",
              },
            ],
            historyMessages: inlineMessages,
            methodResponses: { "chat.message.get": { ok: false, unavailableReason: "not_found" } },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          await pane.locator('[data-entry-id="peer-reply"]').waitFor();
          await page.evaluate(async (selectedTheme) => {
            document.documentElement.dataset.theme = selectedTheme;
            document.documentElement.dataset.themeMode = selectedTheme;
            await document.fonts.ready;
          }, theme);
          for (const dir of ["ltr", "rtl"]) {
            await page.evaluate((direction) => {
              // Locale changes set both; production CSS lowers :dir() to :lang().
              document.documentElement.dir = direction;
              document.documentElement.lang = direction === "rtl" ? "ar" : "en";
            }, dir);
            for (const index of [0, 1]) {
              const plain = pane.locator(`[data-entry-id="plain-${index}"]`);
              const quoted = pane.locator(`[data-entry-id="quoted-${index}"]`);
              const row = quoted.locator(":scope > .chat-reply-attribution--inline");
              expect(await row.count()).toBe(1);
              const geometry = await quoted.evaluate((element) => {
                const bubble = element.getBoundingClientRect();
                const attribution = element.querySelector(".chat-reply-attribution--inline")!;
                const rowBounds = attribution.getBoundingClientRect();
                const person = attribution
                  .querySelector(".chat-reply-attribution__person")!
                  .getBoundingClientRect();
                const avatar = attribution
                  .querySelector(".chat-author-avatar")!
                  .getBoundingClientRect();
                const label = attribution.querySelector(".chat-reply-attribution__label")!;
                const name = attribution.querySelector(".chat-reply-attribution__name")!;
                return {
                  labelOverflow: label.scrollWidth - label.clientWidth,
                  nameOverflow: name.scrollWidth - name.clientWidth,
                  excerptOverflow:
                    attribution.querySelector(".chat-reply-attribution__excerpt-text")!
                      .scrollWidth -
                    attribution.querySelector(".chat-reply-attribution__excerpt-text")!.clientWidth,
                  width: bubble.width,
                  left: rowBounds.left - bubble.left,
                  right: bubble.right - rowBounds.right,
                  height: rowBounds.height,
                  visibleAvatarWidth:
                    Math.min(avatar.right, person.right, rowBounds.right) -
                    Math.max(avatar.left, person.left, rowBounds.left),
                };
              });
              const plainWidth = await plain.evaluate(
                (element) => element.getBoundingClientRect().width,
              );
              expect(geometry.width).toBeGreaterThanOrEqual(plainWidth - 1);
              if (index === 0) {
                expect(geometry.width).toBeGreaterThan(plainWidth);
                expect(geometry.excerptOverflow).toBeGreaterThan(0);
              }
              expect(geometry.labelOverflow).toBeLessThanOrEqual(1);
              expect(geometry.nameOverflow).toBeLessThanOrEqual(1);
              expect(geometry.left).toBeGreaterThanOrEqual(0);
              expect(geometry.right).toBeGreaterThanOrEqual(0);
              expect(geometry.height).toBeLessThan(22);
              expect(geometry.visibleAvatarWidth).toBeGreaterThanOrEqual(16);
              expect(await row.getByRole("button").getAttribute("aria-label")).toBe(
                "Replying to OpenClaw",
              );
              expect(await row.locator(".identity-avatar--agent").count()).toBe(1);
              expect(await row.locator(".chat-reply-connector").count()).toBe(0);
              expect(await row.locator(".chat-reply-attribution__mobile-icon").count()).toBe(0);
              expect(await row.locator(".chat-reply-attribution__excerpt[title]").count()).toBe(0);
              const target = row.getByRole("button");
              const labelElement = row.locator(".chat-reply-attribution__label");
              await row.scrollIntoViewIfNeeded();
              const beforeHover = await row.boundingBox();
              await labelElement.hover();
              const hitArea = await row.evaluate((element) => {
                const label = element.querySelector(".chat-reply-attribution__label")!;
                const targetElement = element.querySelector("button")!;
                const labelBounds = label.getBoundingClientRect();
                const targetBounds = targetElement.getBoundingClientRect();
                return {
                  disjoint:
                    labelBounds.right <= targetBounds.left ||
                    targetBounds.right <= labelBounds.left,
                  targetHovered: targetElement.matches(":hover"),
                  labelCursor: getComputedStyle(label).cursor,
                };
              });
              expect(hitArea.disjoint).toBe(true);
              expect(hitArea.targetHovered).toBe(false);
              expect(hitArea.labelCursor).not.toBe("pointer");
              await target.hover();
              expect(await row.boundingBox()).toEqual(beforeHover);
              await target.focus();
              expect(await row.boundingBox()).toEqual(beforeHover);
              await target.evaluate((element) => element.blur());
            }
            const peerIdentity = await pane
              .locator('[data-entry-id="peer-short"]')
              .evaluate((bubble) =>
                [".chat-reply-attribution__label", ".chat-reply-attribution__name"].map(
                  (selector) => {
                    const element = bubble.parentElement!.querySelector(selector)!;
                    return element.scrollWidth - element.clientWidth;
                  },
                ),
              );
            expect(peerIdentity.every((overflow) => overflow <= 1)).toBe(true);
            if (width < 768) {
              for (const id of ["peer-reply", "peer-short"]) {
                const cue = await pane.locator(`[data-entry-id="${id}"]`).evaluate((bubble) => {
                  const owner = bubble.parentElement!;
                  const row = owner.querySelector(".chat-reply-attribution--reply")!;
                  const icon = row.querySelector(".chat-reply-attribution__mobile-icon")!;
                  const rowBounds = row.getBoundingClientRect();
                  const groupBounds = bubble.closest(".chat-group")!.getBoundingClientRect();
                  return {
                    iconWidth: icon.getBoundingClientRect().width,
                    mirrored: new DOMMatrixReadOnly(getComputedStyle(icon).transform).a,
                    start:
                      getComputedStyle(row).direction === "rtl"
                        ? groupBounds.right - rowBounds.right
                        : rowBounds.left - groupBounds.left,
                  };
                });
                expect(cue.iconWidth).toBe(14);
                expect(cue.mirrored).toBe(dir === "rtl" ? -1 : 1);
                expect(cue.start).toBeCloseTo(0, 1);
              }
            }
          }
          await page.evaluate(() => {
            document.documentElement.dir = "ltr";
            document.documentElement.lang = "en";
          });
          if (width === 1440) {
            const shortQuote = pane.locator('[data-entry-id="quoted-0"]');
            const nameOverflow = () =>
              shortQuote
                .locator(".chat-reply-attribution__name")
                .evaluate((element) => element.scrollWidth - element.clientWidth);
            await shortQuote.evaluate((element) => {
              element.closest<HTMLElement>(".chat-group-messages")!.style.width = "140px";
            });
            await expect.poll(nameOverflow).toBeGreaterThan(1);
            await shortQuote.evaluate((element) => {
              element.closest<HTMLElement>(".chat-group-messages")!.style.width = "500px";
            });
            await expect.poll(nameOverflow).toBeLessThanOrEqual(1);
            await shortQuote.evaluate((element) => {
              element.closest<HTMLElement>(".chat-group-messages")!.style.removeProperty("width");
            });
          }
          const peerReply = pane.locator('[data-entry-id="peer-reply"]');
          await peerReply.scrollIntoViewIfNeeded();
          const peerGroup = peerReply.locator(
            "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-group ')]",
          );
          const stackGeometry = () =>
            peerGroup.locator(".chat-bubble").evaluateAll((bubbles) => {
              const thread = bubbles[0].closest(".chat-thread")!;
              // Native footer disclosure can scroll the transcript on focus.
              const scrollOffset = thread.scrollTop - thread.getBoundingClientRect().top;
              return bubbles.map((bubble) => {
                const rect = bubble.getBoundingClientRect();
                return {
                  top:
                    (bubble.closest(".chat-message--reply")?.getBoundingClientRect().top ??
                      rect.top) + scrollOffset,
                  contentTop: rect.top + scrollOffset,
                  bottom: rect.bottom + scrollOffset,
                  left: rect.left,
                  width: rect.width,
                };
              });
            });
          const peerImage = pane.locator('[data-entry-id="peer-image"]');
          await peerImage
            .getByRole("button", { name: "Open image Image", exact: true })
            .locator("img")
            .evaluate((image) => image.decode());
          const resting = await stackGeometry();
          expect(resting).toHaveLength(4);
          expect(
            await peerGroup
              .locator(
                ".chat-message--reply > :is(.chat-avatar, .chat-avatar-slot), .chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)",
              )
              .count(),
          ).toBe(4);
          expect(
            await pane
              .locator(
                '[data-entry-id="peer-last"] .chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)',
              )
              .count(),
          ).toBe(1);
          if (width < 768) {
            const visiblePeerAvatars = await peerGroup
              .locator(
                ".chat-message--reply > :is(.chat-avatar, .chat-avatar-slot), .chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)",
              )
              .evaluateAll(
                (avatars) =>
                  avatars.filter((avatar) => avatar.getBoundingClientRect().width > 0).length,
              );
            expect(visiblePeerAvatars).toBe(0);
            expect(await peerGroup.locator(".chat-reply-attribution--reply").count()).toBe(2);
          }
          for (let index = 1; index < resting.length; index++) {
            expect(resting[index].top - resting[index - 1].bottom).toBeCloseTo(
              width < 768 ? 52 : 32,
              1,
            );
          }
          for (const id of ["peer-reply", "peer-short"]) {
            const bubble = pane.locator(`[data-entry-id="${id}"]`);
            expect(await bubble.locator(".chat-reply-attribution").count()).toBe(0);
            const placement = await bubble.evaluate((element) => {
              const owner = element.parentElement!;
              const row = owner.querySelector(".chat-reply-attribution--reply")!;
              const avatar = owner.querySelector(
                ":scope > .chat-avatar, :scope > .chat-avatar-slot",
              )!;
              return {
                gap: element.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
                avatarOffset:
                  avatar.getBoundingClientRect().top - element.getBoundingClientRect().top,
                avatarWidth: avatar.getBoundingClientRect().width,
                connectorWidth: owner
                  .querySelector(".chat-reply-connector")!
                  .getBoundingClientRect().width,
                iconWidth: row
                  .querySelector(".chat-reply-attribution__mobile-icon")!
                  .getBoundingClientRect().width,
                sourceAvatarWidth: row.querySelector(".chat-author-avatar")!.getBoundingClientRect()
                  .width,
                start:
                  row.getBoundingClientRect().left -
                  element.closest(".chat-group")!.getBoundingClientRect().left,
              };
            });
            expect(placement.gap).toBeCloseTo(6, 1);
            expect(placement.sourceAvatarWidth).toBe(16);
            if (width < 768) {
              expect(placement.avatarWidth).toBe(0);
              expect(placement.connectorWidth).toBe(0);
              expect(placement.iconWidth).toBe(14);
              expect(placement.start).toBeCloseTo(0, 1);
            } else {
              expect(placement.avatarOffset).toBeCloseTo(0, 1);
              expect(placement.connectorWidth).toBeGreaterThan(0);
              expect(placement.iconWidth).toBe(0);
            }
          }
          const visibleActionRows = () =>
            peerGroup
              .locator(".chat-message-actions-row, .chat-group-footer-actions")
              .evaluateAll(
                (rows) =>
                  rows.filter((row) =>
                    [...row.querySelectorAll("button")].some(
                      (button) => Number(getComputedStyle(button).opacity) > 0.5,
                    ),
                  ).length,
              );
          for (const id of ["peer-reply", "peer-short"]) {
            const bubble = pane.locator(`[data-entry-id="${id}"]`);
            const action = bubble.locator(".chat-message-actions-row button").first();
            if (width < 768) {
              await action.focus();
            } else {
              await bubble.hover();
            }
            await expect.poll(visibleActionRows).toBe(1);
            const position = await action.evaluate((button) => {
              const actionBounds = button.getBoundingClientRect();
              const bubbleBounds = button.closest(".chat-bubble")!.getBoundingClientRect();
              return {
                gap: actionBounds.top - bubbleBounds.bottom,
                start: actionBounds.left - bubbleBounds.left,
              };
            });
            expect(position.gap).toBeGreaterThanOrEqual(0);
            expect(position.gap).toBeLessThanOrEqual(8);
            expect(Math.abs(position.start)).toBeLessThanOrEqual(1);
            expect(await stackGeometry()).toEqual(resting);
            if (width >= 768) {
              await action.hover();
              await expect.poll(visibleActionRows).toBe(1);
              expect(await stackGeometry()).toEqual(resting);
            }
            await page.mouse.move(0, 0);
            await action.focus();
            await expect.poll(visibleActionRows).toBe(1);
            expect(await stackGeometry()).toEqual(resting);
            await action.evaluate((element) => element.blur());
          }
          if (width < 768) {
            const peerText = peerReply.locator(".chat-text");
            await peerText.tap();
            await expect.poll(visibleActionRows).toBe(1);
            const targetHeight = await peerReply
              .locator(".chat-message-actions-row button")
              .first()
              .evaluate((button) => button.getBoundingClientRect().height);
            expect(targetHeight).toBeGreaterThanOrEqual(44);
            expect(await stackGeometry()).toEqual(resting);
            await peerText.tap();
            await page.mouse.move(0, 0);
            await expect.poll(visibleActionRows).toBe(0);
            const besideImage = await peerImage.evaluate((image) => {
              const bubble = image.getBoundingClientRect();
              const group = image.closest(".chat-group")!.getBoundingClientRect();
              return {
                x: (bubble.right + group.right) / 2,
                y: bubble.top + bubble.height / 2,
                bubbleRight: bubble.right,
              };
            });
            expect(besideImage.x).toBeGreaterThan(besideImage.bubbleRight);
            await page.touchscreen.tap(besideImage.x, besideImage.y);
            await expect.poll(visibleActionRows).toBe(1);
            expect(
              await peerImage
                .locator(".chat-message-actions-row button")
                .first()
                .evaluate((button) => Number(getComputedStyle(button).opacity)),
            ).toBeGreaterThan(0.5);
            expect(await page.locator("openclaw-image-lightbox").count()).toBe(0);
            expect(await stackGeometry()).toEqual(resting);
          }

          expect(
            await peerReply.locator("..").locator(".chat-reply-attribution__name").textContent(),
          ).toBe("You");
          expect(
            await peerReply.evaluate((element) =>
              element.closest(".chat-group")!.classList.contains("chat-group--peer"),
            ),
          ).toBe(true);
          expect(
            await pane
              .locator('[data-entry-id="quoted-1"]')
              .evaluate((element) =>
                element.closest(".chat-group")!.classList.contains("chat-group--peer"),
              ),
          ).toBe(false);
          const unavailable = pane.locator(
            '[data-entry-id="inline-missing"] .chat-reply-attribution--inline',
          );
          expect(await unavailable.textContent()).toContain("Original message unavailable");
          expect(await unavailable.evaluate((element) => element.tagName)).not.toBe("BUTTON");
          const available = peerReply.locator("..").getByRole("button", {
            name: "Replying to You",
            exact: true,
          });
          await available.focus();
          await available.press("Enter");
          await expect
            .poll(() => pane.locator('[data-entry-id="inline-self"]').getAttribute("class"))
            .toContain("chat-bubble--reply-target");
          const retained = pane
            .locator('[data-entry-id="peer-short"]')
            .locator("..")
            .getByRole("button", {
              name: "Replying to OpenClaw",
              exact: true,
            });
          await retained.focus();
          await retained.press("Enter");
          await page.getByText("The original message is unavailable.", { exact: true }).waitFor();
        },
      );
    },
  );
});
