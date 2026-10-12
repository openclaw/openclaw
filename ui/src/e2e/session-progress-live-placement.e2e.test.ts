import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import {
  focusChatSidePanel,
  openChatSidePanelType,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "session-progress-live-placement"), { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(path.join(suite.artifactDir, "session-progress-live-placement"), fileName),
  });
}

async function expectInsideDetails(item: Locator): Promise<void> {
  const inside = await item.evaluate((node) => {
    const itemBounds = node.getBoundingClientRect();
    const bodyBounds = node.closest<HTMLElement>(".chat-details")!.getBoundingClientRect();
    return itemBounds.bottom <= bodyBounds.bottom + 1 && itemBounds.top >= bodyBounds.top - 1;
  });
  expect(inside).toBe(true);
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("collapses enabled runs and preserves manual disclosure through finals", async () => {
    const sessionKey = "agent:main:progress-final-expand";
    const proofDir = captureUiProofEnabled
      ? path.join(suite.artifactDir, "session-progress-live-placement")
      : null;
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(proofDir ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } } : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "config.get",
        "progressCard.get",
      ],
      methodResponses: {
        "progressCard.get": { card: null },
        "sessions.list": chatSessionListResponse([
          {
            key: sessionKey,
            kind: "direct",
            label: "Progress final expansion",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey,
    });
    const card = page.locator('[data-progress-card-placement="details"]');
    const captureLifecycleState = async (fileName: string, surface = card) => {
      if (captureUiProofEnabled) {
        await page.waitForTimeout(250);
        await writeFile(
          path.join(suite.artifactDir, "session-progress-live-placement", fileName),
          await takeControlUiViewportScreenshot(page, surface, [surface]),
        );
        await page.waitForTimeout(500);
      }
    };
    const setProgressCard = async (
      revision: number,
      markdown: string,
      steps: Array<{ status: "completed" | "in_progress" | "pending"; step: string }>,
    ) => {
      await gateway.setMethodResponse("progressCard.get", {
        card: { markdown, revision, sessionKey, steps, updatedAt: Date.now() },
      });
      await gateway.emitGatewayEvent("progressCard.changed", { revision, sessionKey });
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

    try {
      await page.goto(
        `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
      );
      await waitForControlUiSettingsTakeover(page);
      const settingRow = page
        .locator(".settings-row")
        .filter({
          has: page.locator(".settings-row__title", {
            hasText: "Collapse task progress by default on desktop",
          }),
        })
        .first();
      const settingSwitch = settingRow.getByRole("switch");
      await expect.poll(() => settingSwitch.isChecked()).toBe(false);
      await settingRow.click();
      await expect.poll(() => settingSwitch.isChecked()).toBe(true);
      await captureLifecycleState("01-setting-enabled.png", settingRow);

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const runOneId = await send("Run the first progress cycle");
      await setProgressCard(1, "Run one started", [
        { status: "in_progress", step: "Inspect first run" },
        { status: "pending", step: "Verify first run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("02-run-one-collapsed.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await setProgressCard(2, "Run one revised", [
        { status: "completed", step: "Inspect first run" },
        { status: "in_progress", step: "Verify first run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("03-run-one-manual-open-survives-update.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("04-run-one-manual-close-before-final.png");

      await gateway.emitChatFinal({
        runId: runOneId,
        sessionKey,
        text: "The first progress cycle is complete.",
      });
      await page
        .locator(".chat-bubble p", { hasText: "The first progress cycle is complete." })
        .waitFor();
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("05-run-one-final-keeps-manual-collapse.png");
      await setProgressCard(3, "Run one final card revision", [
        { status: "completed", step: "Inspect first run" },
        { status: "completed", step: "Verify first run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await captureLifecycleState("06-run-one-manual-close-survives-rerender.png");

      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("07-run-one-manual-reopen-before-next-run.png");

      await send("Run the second progress cycle");
      await openChatDetails(page);
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("08-run-two-manual-open.png");
      await setProgressCard(4, "Run two started", [
        { status: "in_progress", step: "Inspect second run" },
        { status: "pending", step: "Verify second run" },
      ]);
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await captureLifecycleState("09-run-two-progress-manual-open.png");
    } finally {
      await page.close();
      if (proofDir && video) {
        const recordingPath = await video.path();
        await video.saveAs(path.join(proofDir, "task-progress-final-expand-cycle.webm"));
        await unlink(recordingPath);
      }
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps one live card placement and a compact transcript receipt", async () => {
    const sessionKey = "agent:main:progress-placement";
    const updatedAt = Date.now() - 5 * 60_000;
    const plan = [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" },
    ];

    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
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
          methodResponses: {
            "progressCard.get": {
              card: {
                markdown: "**Implementation** is moving.",
                revision: 2,
                sessionKey,
                steps: plan,
                updatedAt,
              },
            },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Progress placement",
                hasActiveRun: true,
                activeRunIds: ["stale-run"],
                status: "completed",
                updatedAt,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
        await openChatDetails(page);

        const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        expect(await visiblePane.locator('[data-progress-card-placement="composer"]').count()).toBe(
          0,
        );
        expect(await visiblePane.locator(".chat-footer .chat-prs").count()).toBe(0);
        const expectVisibleLastActivity = async (placement: "details") => {
          const card = visiblePane.locator(`[data-progress-card-placement="${placement}"]`);
          const timestamp = card.locator("time");
          await expect
            .poll(() => timestamp.getAttribute("datetime"))
            .toBe(new Date(updatedAt).toISOString());
          await expect.poll(() => timestamp.getAttribute("aria-label")).toMatch(/^Updated /);
          await expect.poll(() => timestamp.textContent()).toMatch(/^Updated /);
          await expect.poll(() => timestamp.isVisible()).toBe(true);
          const accessibleCard = card.locator("summary");
          await expect
            .poll(() => accessibleCard.getAttribute("aria-label"))
            .not.toContain("Updated");
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
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="details"]').count())
          .toBe(1);
        const pausedStep = visiblePane.locator(".session-progress-card__step--paused");
        await expect
          .poll(() =>
            visiblePane.locator('[data-progress-card-placement="details"]').getAttribute("open"),
          )
          .toBe("");
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
        const detailsCard = visiblePane.locator('[data-progress-card-placement="details"]');
        await expect.poll(() => detailsCard.getAttribute("open")).toBeNull();
        await expect
          .poll(() => detailsCard.locator(".session-progress-card__current").textContent())
          .toBe("Implement");
        await detailsCard.locator("summary").click();
        await expect.poll(() => detailsCard.getAttribute("open")).toBe("");
        await expect.poll(() => pausedStep.getAttribute("aria-label")).toBe("Implement, paused");
        await expect
          .poll(() => visiblePane.locator(".session-progress-card .session-run-spinner").count())
          .toBe(0);
        await expectVisibleLastActivity("details");
        await captureProof(page, "details-wide.png");

        await page.setViewportSize({ height: 900, width: 1280 });
        await openChatSidePanelType(page, "Side chat");
        await openChatDetails(visiblePane);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="details"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);

        const receipt = visiblePane.locator(".chat-thread .chat-progress-card-receipt");
        await expect
          .poll(() => receipt.textContent())
          .toContain("Progress updated — 1/3 · Implement");
        await expect.poll(() => receipt.locator(".chat-tool-msg-body").count()).toBe(0);
        await expect
          .poll(() => visiblePane.locator(".chat-thread").textContent())
          .not.toContain("Implementation is moving.");
        await expectVisibleLastActivity("details");
        await captureProof(page, "details-with-side-chat.png");

        const sidePanel = visiblePane.locator(".sidebar-region__right-runtime .side-panel");
        await focusChatSidePanel(page);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="details"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        await page
          .locator(".chat-pane__header")
          .getByRole("button", { name: "Restore split", exact: true })
          .click();
        await restoreChatAsMain(page);
        await openChatDetails(visiblePane);

        await page.setViewportSize({ height: 900, width: 560 });
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="details"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        const sideHeader = sidePanel.locator('[data-region-header="side"]');
        await sideHeader.getByRole("button", { name: "Close", exact: true }).click();
        await sideHeader.waitFor({ state: "hidden" });
        await openChatDetails(visiblePane);
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="details"]').isVisible())
          .toBe(true);
        await expectVisibleLastActivity("details");
        await captureProof(page, "details-mobile.png");
      },
    );
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
    const variants = [
      { name: "markdown-only", steps: undefined },
      {
        name: "markdown-and-plan",
        steps: Array.from({ length: 8 }, (_, index) => ({
          status: index < 3 ? ("completed" as const) : ("pending" as const),
          step: `Plan step ${index + 1}`,
        })),
      },
    ];

    for (const variant of variants) {
      const sessionKey = `agent:main:progress-${variant.name}`;
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 700, width: 980 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
            methodResponses: {
              "progressCard.get": {
                card: {
                  markdown,
                  revision: 1,
                  sessionKey,
                  steps: variant.steps,
                  updatedAt: 1,
                },
              },
              "sessions.list": chatSessionListResponse([
                {
                  key: sessionKey,
                  kind: "direct",
                  label: `Progress ${variant.name}`,
                  updatedAt: 1,
                },
              ]),
            },
            sessionKey,
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);
          await openChatDetails(page);
          const card = page.locator('[data-progress-card-placement="details"]');
          const body = page.locator('.chat-details[role="dialog"]');
          await expect.poll(() => card.isVisible()).toBe(true);
          await expect.poll(() => card.getAttribute("open")).toBe("");

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
          await captureProof(page, `tall-${variant.name}-after-scrolled.png`);

          if (variant.steps) {
            const lastStep = card.locator(".session-progress-card__step:last-child");
            await lastStep.scrollIntoViewIfNeeded();
            await expectInsideDetails(lastStep);
            expect(
              await card
                .locator(".session-progress-card__steps")
                .evaluate((node) => node.clientHeight),
            ).toBeGreaterThan(0);
            expect(await page.evaluate(() => window.scrollY)).toBe(0);
            await captureProof(page, `tall-${variant.name}-final-step.png`);
          }
        },
      );
    }
  });

  it.each([
    {
      name: "completed",
      colorScheme: "light" as const,
      width: 560,
      status: "completed",
      active: false,
    },
    {
      name: "paused",
      colorScheme: "dark" as const,
      width: 1280,
      status: "in_progress",
      active: false,
    },
    {
      name: "active",
      colorScheme: "dark" as const,
      width: 560,
      status: "in_progress",
      active: true,
    },
    {
      name: "note-only",
      colorScheme: "light" as const,
      width: 390,
      status: undefined,
      active: false,
    },
  ])(
    "hides $name progress locally without clearing the saved card",
    async ({ name, colorScheme, width, status, active }) => {
      const sessionKey = "agent:main:progress-dismiss";
      const updatedAt = Date.now() - (active ? 60_000 : 22 * 60 * 60_000);
      const plan = status
        ? [
            { step: "Inspect the workspace", status },
            { step: "Verify the change", status: status === "completed" ? "completed" : "pending" },
          ]
        : undefined;
      const initialCard = {
        revision: 3,
        sessionKey,
        steps: plan,
        markdown: status ? undefined : "The workspace review is waiting for a decision.",
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
          const gateway = await installMockGateway(page, {
            agentModel: "example/demo-model",
            models: [
              { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
            ],
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
              {
                role: "user",
                content: [{ type: "text", text: "Review the workspace and verify the change." }],
              },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "The task progress card tracks the workspace checks." },
                ],
              },
            ],
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "progressCard.get",
              "progressCard.refresh",
            ],
            methodResponses: {
              "progressCard.get": { card: initialCard },
              "sessions.list": sessions,
            },
            sessionKey,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const card = page.locator('[data-progress-card-placement="details"]');
          await openChatDetails(page);
          await expect.poll(() => card.isVisible()).toBe(true);
          if ((await card.getAttribute("open")) === null) {
            await card.locator("summary").click();
          }
          await captureProof(page, "hide-" + name + "-expanded-before.png");
          await card.getByRole("button", { name: "Dismiss progress card" }).click();
          await expect.poll(() => card.count()).toBe(0);
          await captureProof(page, "hide-" + name + "-after.png");
          expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);

          if (name === "active") {
            const latestCard = { ...initialCard, revision: 4, updatedAt: updatedAt + 1 };
            await gateway.setMethodResponse("progressCard.get", { card: latestCard });
            await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 4 });
            await gateway.waitForRequest("progressCard.get", { after: 1 });
            await expect.poll(() => card.count()).toBe(0);
            const peer = await page.context().newPage();
            try {
              const peerGateway = await installMockGateway(peer, {
                sessionKey,
                featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
                methodResponses: {
                  "progressCard.get": { card: latestCard },
                  "sessions.list": sessions,
                },
              });
              await peer.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
              await openChatDetails(peer);
              await expect
                .poll(() => peer.locator('[data-progress-card-placement="details"]').isVisible())
                .toBe(true);
              expect(await peerGateway.getRequests("progressCard.put")).toHaveLength(0);
              expect(await card.count()).toBe(0);
            } finally {
              await peer.close();
            }
          }

          await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("draft");
          expect(await card.count()).toBe(0);
          await page.reload();
          await openChatDetails(page);
          await expect.poll(() => card.isVisible()).toBe(true);
          expect(await card.textContent()).toContain(
            plan?.[0]?.step ?? "The workspace review is waiting for a decision.",
          );
          if ((await card.getAttribute("open")) !== null) {
            await card.locator("summary").click();
          }
          await captureProof(page, "hide-" + name + "-collapsed-before.png");
          await card.getByRole("button", { name: "Dismiss progress card" }).press("Enter");
          await expect.poll(() => card.count()).toBe(0);
          expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
          await page.reload();
          await openChatDetails(page);
          await expect.poll(() => card.isVisible()).toBe(true);
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
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 560 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get", "progressCard.put"],
          methodResponses: {
            "progressCard.get": { card: initialCard },
            "progressCard.put": { card: null },
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Workspace review", updatedAt: 1 },
            ]),
          },
          sessionKey,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator('[data-progress-card-placement="details"]');
        await openChatDetails(page);
        await expect.poll(() => card.isVisible()).toBe(true);
        await card.getByRole("button", { name: "Task progress options" }).click();
        const clear = card.locator('wa-dropdown-item[value="clear"]');
        await expect.poll(() => clear.isVisible()).toBe(true);
        await captureProof(page, "clear-separate-control-before.png");
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
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          hasMultipleSessionSharingIdentities: true,
          methodResponses: {
            "progressCard.get": {
              card: {
                revision: 1,
                sessionKey,
                steps: [{ step: "Completed work", status: "completed" }],
                updatedAt: 1,
              },
            },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Restricted progress",
                sharingRole: "viewer",
                updatedAt: 1,
                visibility: "suggest",
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator('[data-progress-card-placement="details"]');
        await openChatDetails(page);
        await expect.poll(() => card.isVisible()).toBe(true);
        expect(await card.locator('wa-dropdown-item[value="clear"]').count()).toBe(0);
        await card.getByRole("button", { name: "Dismiss progress card" }).click();
        await expect.poll(() => card.count()).toBe(0);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        await page.reload();
        await openChatDetails(page);
        await expect.poll(() => card.isVisible()).toBe(true);
      },
    );
  });
});
