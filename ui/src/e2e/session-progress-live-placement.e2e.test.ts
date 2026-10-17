import type { ProgressCardStepStatus } from "@openclaw/gateway-protocol";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatMessage,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import {
  focusChatSidePanel,
  openChatSidePanelType,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";
import {
  installProgressGateway as installProgress,
  progressMethods,
  updateCard,
} from "./session-progress.test-support.ts";

async function expectInsideDetails(item: Locator): Promise<void> {
  const inside = await item.evaluate((node) => {
    const itemBounds = node.getBoundingClientRect();
    const bodyBounds = node.closest<HTMLElement>(".chat-details")!.getBoundingClientRect();
    return itemBounds.bottom <= bodyBounds.bottom + 1 && itemBounds.top >= bodyBounds.top - 1;
  });
  expect(inside).toBe(true);
}

const suite = createChatFlowE2eSuite();
const desktop = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} as const;
const placement = (root: Page | Locator, name = "details") =>
  root.locator(`[data-progress-card-placement="${name}"]`);
async function expectPlacement(root: Locator, name: string, count: number) {
  await expect.poll(() => placement(root, name).count()).toBe(count);
}
async function openProgress(page: Page, sessionKey: string) {
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const card = placement(page);
  await openChatDetails(page);
  await expect.poll(() => card.isVisible()).toBe(true);
  return card;
}
async function reloadProgress(page: Page, card: Locator) {
  await page.reload();
  await openChatDetails(page);
  await expect.poll(() => card.isVisible()).toBe(true);
}
async function expectOpen(card: Locator, open: boolean) {
  await expect.poll(() => card.getAttribute("open")).toBe(open ? "" : null);
}

suite.define(() => {
  it("collapses enabled runs and preserves manual disclosure through finals", async () => {
    const sessionKey = "agent:main:progress-final-expand";
    await suite.withPage(desktop, async ({ page }) => {
      const gateway = await installProgress(page, {
        sessionKey,
        featureMethods: [
          "chat.metadata",
          "chat.send",
          "chat.startup",
          "config.get",
          "progressCard.get",
        ],
      });
      const card = placement(page);
      const setProgressCard = async (
        revision: number,
        markdown: string,
        statuses: [ProgressCardStepStatus, ProgressCardStepStatus],
        run = "first",
      ) => {
        await updateCard(gateway, {
          markdown,
          revision,
          sessionKey,
          updatedAt: Date.now(),
          steps: [
            { step: `Inspect ${run} run`, status: statuses[0] },
            { step: `Verify ${run} run`, status: statuses[1] },
          ],
        });
        await expect.poll(() => card.textContent()).toContain(markdown);
        await openChatDetails(page);
      };
      const send = async (message: string) => {
        const requestCount = (await gateway.getRequests("chat.send")).length;
        await page.locator(".agent-chat__composer-combobox textarea").fill(message);
        await page.getByRole("button", { name: "Send message" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("chat.send")).length)
          .toBe(requestCount + 1);
        const requests = await gateway.getRequests("chat.send");
        return requireString(
          requireRecord(requests[requestCount]!.params).idempotencyKey,
          "chat send idempotency key",
        );
      };

      await page.goto(
        `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
      );
      await waitForControlUiSettingsTakeover(page);
      const settingRow = page
        .locator(".settings-row", {
          has: page.locator(".settings-row__title", {
            hasText: "Collapse task progress by default on desktop",
          }),
        })
        .first();
      const settingSwitch = settingRow.getByRole("switch");
      await expect.poll(() => settingSwitch.isChecked()).toBe(false);
      await settingRow.click();
      await expect.poll(() => settingSwitch.isChecked()).toBe(true);

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const runOneId = await send("Run the first progress cycle");
      await setProgressCard(1, "Run one started", ["in_progress", "pending"]);
      await expectOpen(card, false);

      await card.locator("summary").click();
      await expectOpen(card, true);
      await setProgressCard(2, "Run one revised", ["completed", "in_progress"]);
      await expectOpen(card, true);

      await card.locator("summary").click();
      await expectOpen(card, false);

      await gateway.emitChatFinal({
        runId: runOneId,
        sessionKey,
        text: "The first progress cycle is complete.",
      });
      await page
        .locator(".chat-bubble p", { hasText: "The first progress cycle is complete." })
        .waitFor();
      await expectOpen(card, false);

      await setProgressCard(3, "Run one final card revision", ["completed", "completed"]);
      await expectOpen(card, false);

      await card.locator("summary").click();
      await expectOpen(card, true);

      await send("Run the second progress cycle");
      await openChatDetails(page);
      await expectOpen(card, true);

      await setProgressCard(4, "Run two started", ["in_progress", "pending"], "second");
      await expectOpen(card, true);
    });
  });

  it("keeps one live card placement and a compact transcript receipt", async () => {
    const sessionKey = "agent:main:progress-placement";
    const updatedAt = Date.now() - 5 * 60_000;
    const plan = [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" },
    ];

    await suite.withPage(desktop, async ({ page }) => {
      const gateway = await installProgress(page, {
        sessionKey,
        card: {
          markdown: "**Implementation** is moving.",
          revision: 2,
          sessionKey,
          steps: plan,
          updatedAt,
        },
        row: {
          label: "Progress placement",
          hasActiveRun: true,
          activeRunIds: ["stale-run"],
          status: "completed",
          updatedAt,
        },
        historyMessages: [
          {
            id: "progress-receipt",
            role: "assistant",
            timestamp: 1,
            content: [
              {
                type: "toolcall",
                id: "progress-call",
                name: "progress_card",
                arguments: { markdown: "Implementation is moving.", plan },
              },
              {
                type: "toolresult",
                id: "progress-call",
                name: "progress_card",
                text: "Progress card updated (rev 2, 1/3 done)",
              },
            ],
          },
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
      await openChatDetails(page);

      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      expect(await placement(pane, "composer").count()).toBe(0);
      expect(await pane.locator(".chat-footer .chat-prs").count()).toBe(0);
      const expectVisibleLastActivity = async () => {
        const card = placement(pane);
        const timestamp = card.locator("time");
        await expect
          .poll(() => timestamp.getAttribute("datetime"))
          .toBe(new Date(updatedAt).toISOString());
        await expect.poll(() => timestamp.getAttribute("aria-label")).toMatch(/^Updated /);
        await expect.poll(() => timestamp.textContent()).toMatch(/^Updated /);
        await expect.poll(() => timestamp.isVisible()).toBe(true);
        const accessibleCard = card.locator("summary");
        await expect.poll(() => accessibleCard.getAttribute("aria-label")).not.toContain("Updated");
        const timestampBounds = await timestamp.boundingBox();
        const cardBounds = await card.boundingBox();
        if (!timestampBounds || !cardBounds) {
          throw new Error("The progress card and last activity time must both remain visible");
        }
        expect(timestampBounds.x + timestampBounds.width).toBeLessThanOrEqual(
          cardBounds.x + cardBounds.width,
        );
      };
      await page.setViewportSize({ height: 900, width: 1600 });
      await expectPlacement(pane, "details", 1);
      const pausedStep = pane.locator(".session-progress-card__step--paused");
      await expect.poll(() => placement(pane).getAttribute("open")).toBe("");
      await page.evaluate(
        ({ gatewayUrl, settingsKey }) => {
          localStorage.setItem(
            settingsKey,
            JSON.stringify({ gatewayUrl, chatCollapseTaskProgress: true }),
          );
        },
        {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        },
      );
      await page.reload();
      await openChatDetails(page);
      const detailsCard = placement(pane);
      await expectOpen(detailsCard, false);
      await expect
        .poll(() => detailsCard.locator(".session-progress-card__current").textContent())
        .toBe("Implement");
      await detailsCard.locator("summary").click();
      await expectOpen(detailsCard, true);
      await expect.poll(() => pausedStep.getAttribute("aria-label")).toBe("Implement, paused");
      await expect
        .poll(() => pane.locator(".session-progress-card .session-run-spinner").count())
        .toBe(0);
      await expectVisibleLastActivity();

      await page.setViewportSize({ height: 900, width: 1280 });
      await openChatSidePanelType(page, "Side chat");
      await openChatDetails(pane);
      await expectPlacement(pane, "details", 1);
      await expectPlacement(pane, "rail", 0);
      await expect.poll(() => pane.locator(".session-progress-card").count()).toBe(1);

      const receipt = pane.locator(".chat-thread .chat-progress-card-receipt");
      await expect
        .poll(() => receipt.textContent())
        .toContain("Progress updated — 1/3 · Implement");
      await expect.poll(() => receipt.locator(".chat-tool-msg-body").count()).toBe(0);
      await expect
        .poll(() => pane.locator(".chat-thread").textContent())
        .not.toContain("Implementation is moving.");
      await expectVisibleLastActivity();

      const sidePanel = pane.locator(".sidebar-region__right-runtime .side-panel");
      await focusChatSidePanel(page);
      await expectPlacement(pane, "details", 1);
      await expectPlacement(pane, "rail", 0);
      await selectChatLayoutAction(page, "Restore split");
      await restoreChatAsMain(page);
      await openChatDetails(pane);

      await page.setViewportSize({ height: 900, width: 560 });
      await expectPlacement(pane, "details", 1);
      await expectPlacement(pane, "rail", 0);
      const sideHeader = sidePanel.locator('[data-region-header="side"]');

      await expect
        .poll(() =>
          pane.evaluate((element) => {
            const header = element.querySelector(".sidebar-region__header")!;
            const details = element.querySelector(".chat-details")!;
            return details.getBoundingClientRect().top >= header.getBoundingClientRect().bottom;
          }),
        )
        .toBe(true);
      await selectChatLayoutAction(page, "Minimize side panel");
      await sideHeader.waitFor({ state: "hidden" });
      await openChatDetails(pane);
      await expect.poll(() => pane.locator(".session-progress-card").count()).toBe(1);
      await expect.poll(() => placement(pane).isVisible()).toBe(true);
      await expectVisibleLastActivity();
    });
  });

  it("keeps tall markdown-only and mixed progress cards scroll-reachable", async () => {
    const markdown = [
      "| Gate | State |",
      "| --- | --- |",
      ...Array.from(
        { length: 24 },
        (_, index) => `| Gate ${index + 1} | Detailed state for gate ${index + 1} |`,
      ),
    ].join("\n");
    for (const withPlan of [false, true]) {
      const sessionKey = `agent:main:progress-${withPlan ? "markdown-and-plan" : "markdown-only"}`;
      const steps = withPlan
        ? Array.from({ length: 8 }, (_, index) => ({
            status: index < 3 ? "completed" : "pending",
            step: `Plan step ${index + 1}`,
          }))
        : undefined;
      await suite.withPage(
        { ...desktop, viewport: { height: 700, width: 980 } },
        async ({ page }) => {
          const gateway = await installProgress(page, {
            sessionKey,
            card: {
              markdown,
              revision: 1,
              sessionKey,
              steps,
              updatedAt: 1,
            },
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
          await openChatDetails(page);
          const card = placement(page);
          const body = page.locator('.chat-details[role="dialog"]');
          await expect.poll(() => card.isVisible()).toBe(true);
          await expectOpen(card, true);

          const bodyLayout = await body.evaluate((node) => ({
            clientHeight: node.clientHeight,
            overflowY: getComputedStyle(node).overflowY,
            scrollHeight: node.scrollHeight,
          }));
          expect(bodyLayout.overflowY).toBe("auto");
          expect(bodyLayout.scrollHeight).toBeGreaterThan(bodyLayout.clientHeight);

          const lastMarkdownRow = card.locator("tbody tr:last-child");
          await lastMarkdownRow.scrollIntoViewIfNeeded();
          await expectInsideDetails(lastMarkdownRow);
          expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          expect(await page.evaluate(() => window.scrollY)).toBe(0);

          if (steps) {
            const lastStep = card.locator(".session-progress-card__step:last-child");
            await lastStep.scrollIntoViewIfNeeded();
            await expectInsideDetails(lastStep);
            expect(
              await card
                .locator(".session-progress-card__steps")
                .evaluate((node) => node.clientHeight),
            ).toBeGreaterThan(0);
            expect(await page.evaluate(() => window.scrollY)).toBe(0);
          }
        },
      );
    }
  });

  it.each([
    [true, "dark", 560],
    [false, "light", 390],
  ] as const)(
    "hides progress locally without clearing the saved card (active=%s, %s, %s px)",
    async (active, colorScheme, width) => {
      const sessionKey = "agent:main:progress-dismiss";
      const updatedAt = Date.now() - (active ? 60_000 : 22 * 60 * 60_000);
      const plan = active
        ? [
            { step: "Inspect the workspace", status: "in_progress" },
            { step: "Verify the change", status: "pending" },
          ]
        : undefined;
      const initialCard = {
        revision: 3,
        sessionKey,
        steps: plan,
        markdown: active ? undefined : "The workspace review is waiting for a decision.",
        updatedAt,
      };
      const sessions = chatSessionListResponse([
        {
          key: sessionKey,
          kind: "direct",
          label: "Workspace review",
          hasActiveRun: active,
          activeRunIds: active ? ["progress-run"] : [],
          updatedAt,
        },
      ]);
      await suite.withPage(
        { colorScheme, locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width } },
        async ({ page }) => {
          const gateway = await installProgress(page, {
            sessionKey,
            card: initialCard,
            roster: sessions,
            sessionInfo: {
              key: sessionKey,
              hasActiveRun: active,
              startedAt: active ? updatedAt - 60_000 : undefined,
              activeRunIds: active ? ["progress-run"] : [],
            },
            ...(active
              ? { inFlightRun: { runId: "progress-run", text: "Checking the workspace." } }
              : {}),
            historyMessages: [
              chatMessage("assistant", "The task progress card tracks the workspace checks."),
            ],
            featureMethods: [...progressMethods, "progressCard.refresh"],
          });
          const card = await openProgress(page, sessionKey);
          if ((await card.getAttribute("open")) === null) {
            await card.locator("summary").click();
          }

          await card.getByRole("button", { name: "Task progress options" }).click();
          await card.getByRole("menuitem", { name: "Hide this card", exact: true }).click();
          await expect.poll(() => card.count()).toBe(0);

          expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);

          if (active) {
            const latestCard = { ...initialCard, revision: 4, updatedAt: updatedAt + 1 };
            await updateCard(gateway, latestCard);
            await gateway.waitForRequest("progressCard.get", { after: 1 });
            await expect.poll(() => card.count()).toBe(0);
            const peer = await page.context().newPage();
            try {
              const peerGateway = await installProgress(peer, {
                sessionKey,
                card: latestCard,
                roster: sessions,
              });
              await openProgress(peer, sessionKey);
              expect(await peerGateway.getRequests("progressCard.put")).toHaveLength(0);
              expect(await card.count()).toBe(0);
            } finally {
              await peer.close();
            }
          }

          await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("draft");
          expect(await card.count()).toBe(0);
          await reloadProgress(page, card);
          expect(await card.textContent()).toContain(
            plan?.[0]?.step ?? "The workspace review is waiting for a decision.",
          );
          if ((await card.getAttribute("open")) !== null) {
            await card.locator("summary").click();
          }

          await card.getByRole("button", { name: "Task progress options" }).press("Enter");
          await card.getByRole("menuitem", { name: "Hide this card", exact: true }).press("Enter");
          await expect.poll(() => card.count()).toBe(0);
          expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
          await reloadProgress(page, card);
        },
      );
    },
  );

  it("keeps shared clearing as a separate authorized action", async () => {
    const sessionKey = "agent:main:progress-clear";
    const initialCard = {
      revision: 3,
      sessionKey,
      steps: [{ step: "Verify the change", status: "in_progress" as const }],
      updatedAt: Date.now(),
    };
    await suite.withPage(
      { ...desktop, viewport: { height: 900, width: 560 } },
      async ({ page }) => {
        const gateway = await installProgress(page, {
          sessionKey,
          card: initialCard,
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get", "progressCard.put"],
          methodResponses: { "progressCard.put": { card: null } },
        });
        const card = await openProgress(page, sessionKey);
        await card.getByRole("button", { name: "Task progress options" }).click();
        const clear = card.locator('[data-value="clear"]');
        await expect.poll(() => clear.isVisible()).toBe(true);

        await clear.click();
        await expect.poll(() => gateway.getRequests("progressCard.put")).toHaveLength(1);
        expect(
          requireRecord((await gateway.getRequests("progressCard.put"))[0]!.params),
        ).toMatchObject({
          sessionKey,
          expectedRevision: initialCard.revision,
        });
        await expect.poll(() => card.count()).toBe(0);
        await gateway.setMethodResponse("progressCard.get", { card: null });
        await page.reload();
        await openChatDetails(page);
        await expect.poll(() => card.count()).toBe(0);
      },
    );
  });

  it("lets a restricted viewer hide progress locally without a write grant", async () => {
    const sessionKey = "agent:main:progress-viewer";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 560 },
      },
      async ({ page }) => {
        const gateway = await installProgress(page, {
          sessionKey,
          card: {
            revision: 1,
            sessionKey,
            steps: [{ step: "Completed work", status: "completed" }],
            updatedAt: 1,
          },
          row: { label: "Restricted progress", sharingRole: "viewer", visibility: "suggest" },
          hasMultipleSessionSharingIdentities: true,
        });

        const card = await openProgress(page, sessionKey);
        expect(await card.locator('[data-value="clear"]').count()).toBe(0);
        await card.getByRole("button", { name: "Task progress options" }).click();
        await card.getByRole("menuitem", { name: "Hide this card", exact: true }).click();
        await expect.poll(() => card.count()).toBe(0);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        await reloadProgress(page, card);
      },
    );
  });
});
