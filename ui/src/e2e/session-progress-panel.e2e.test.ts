import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("floats task progress over the transcript and collapses when another panel opens", async () => {
    const sessionKey = "agent:main:progress-panel";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1440, height: 1000 } },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "example/demo-model",
          models: [
            { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
          ],
          featureMethods: [
            "browser.request",
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "progressCard.put",
            "progressCard.refresh",
          ],
          historyMessages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Explain this change in simple terms, with a before and after.",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: [
                    "The change stops rebuilding unchanged plugins whenever a new runtime is prepared. Instead, the runtime safely reuses the plugins already loaded by the Gateway.",
                    "### Before",
                    "Changing a model setting could trigger repeated work:",
                    "~~~text\nChange setting\n  → Prepare a new runtime\n  → Load separate plugin copies\n  → Inspect dependencies again\n  → Gateway waits while it works\n~~~",
                    "For small plugins, the extra work could go unnoticed. With large dependencies, it became expensive.",
                    "### After",
                    "~~~text\nChange setting\n  → Prepare a new runtime\n  → Check which plugins changed\n  → Reuse unchanged plugins\n  → Keep the Gateway responsive\n~~~",
                    "The remaining shutdown regression is tracked in task progress. The runtime fix is ready, but the change is not merged yet.",
                  ].join("\n\n"),
                },
              ],
            },
          ],
          methodResponses: {
            "browser.request": {
              cases: [
                { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
              ],
            },
            "progressCard.refresh": { runId: "progress-refresh", status: "accepted", revision: 1 },
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: Date.now(),
                markdown:
                  "**Landing is paused, not merged.** The runtime fix is ready. Closing one Gateway can still interrupt a sibling that is serving requests. Repairing the shared publication boundary before landing.",
                steps: [
                  { step: "Repair and verify the remaining CI fixture", status: "completed" },
                  { step: "Repair the live-sibling shutdown regression", status: "in_progress" },
                  { step: "Verify remote merge and close task resources", status: "pending" },
                ],
              },
            },
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Plugin runtime reuse", updatedAt: 1 },
            ]),
          },
        });
        const regionModule = await holdModuleResponse(
          page,
          /\/assets\/chat-sidebar-region\.runtime-[^/]+\.js$/u,
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator('[data-progress-card-placement="composer"]');
        await expect.poll(() => card.isVisible()).toBe(true);
        await expect.poll(() => card.getAttribute("open")).toBe("");
        await page.evaluate(() => document.fonts.ready);
        await captureUiProof(suite, page, "progress-panel", "before.png");
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const savedLayouts = () =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}").sidebarSessionLayouts ?? {},
            settingsKey,
          );
        const originalLayouts = await savedLayouts();
        const settingsPage = await context.newPage();
        const settingsGateway = await installMockGateway(settingsPage, { sessionKey });
        await settingsPage.goto(
          suite.server.baseUrl +
            "settings/appearance?section=__appearance__#settings-appearance-chat",
        );
        await waitForControlUiSettingsTakeover(settingsPage);
        const row = (title: string) =>
          settingsPage
            .locator(".settings-row")
            .filter({ has: settingsPage.locator(".settings-row__title", { hasText: title }) })
            .first();
        const floatPreference = row("Float task progress above the conversation");
        await expect
          .poll(() =>
            floatPreference
              .locator("wa-switch")
              .evaluate((element) => Reflect.get(element, "checked")),
          )
          .toBe(false);
        await floatPreference.click();
        await page.bringToFront();
        const floating = page.locator('[data-progress-card-placement="floating"]');
        const toggle = floating.locator("button[aria-expanded]");
        const settled = async () => {
          await floating.evaluate(async (element) => {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
            await Promise.all(
              element
                .getAnimations({ subtree: true })
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
            );
          });
        };
        await expect.poll(() => floating.isVisible()).toBe(true);
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        await settled();
        expect(await card.count()).toBe(0);
        expect(await page.locator(".agent-chat__progress-float--loading").count()).toBe(0);
        expect(await savedLayouts()).toEqual(originalLayouts);
        expect(regionModule.requests()).toBe(0);
        const radii = await floating.evaluate((element) => ({
          progress: getComputedStyle(element).borderTopRightRadius,
          composer: getComputedStyle(element.closest(".chat")!.querySelector(".agent-chat__input")!)
            .borderTopRightRadius,
        }));
        expect(radii.progress).toBe(radii.composer);
        await captureUiProof(suite, page, "floating-progress", "after-expanded.png");
        const draft = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await draft.fill("Keep this draft while panels change.");
        const threadGeometry = () =>
          page.locator(".chat-thread").evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return { width: bounds.width, height: bounds.height };
          });
        const originalThread = await threadGeometry();
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
        await settled();
        const collapsedHeight = await floating.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        expect(await threadGeometry()).toEqual(originalThread);
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        const motion = await floating.evaluate(async (element) => {
          const heights: number[] = [];
          await new Promise<void>((resolve) => {
            const sample = () => {
              heights.push(element.getBoundingClientRect().height);
              const animations = element
                .getAnimations({ subtree: true })
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
              if (
                animations.some(
                  (animation) => animation.playState === "running" || animation.pending,
                )
              ) {
                requestAnimationFrame(sample);
              } else {
                resolve();
              }
            };
            requestAnimationFrame(sample);
          });
          return heights;
        });
        const expandedHeight = await floating.evaluate(
          (element) => element.getBoundingClientRect().height,
        );
        expect(expandedHeight).toBeGreaterThan(collapsedHeight + 40);
        expect(
          motion.some((height) => height > collapsedHeight + 1 && height < expandedHeight - 1),
        ).toBe(true);
        expect(await threadGeometry()).toEqual(originalThread);
        expect(await draft.inputValue()).toBe("Keep this draft while panels change.");

        // An intentionally delayed sidebar import must not hide floating progress.
        await page.locator(".chat-side-panel-toggle").click();
        await regionModule.request;
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await floating.isVisible()).toBe(true);
        expect(await card.count()).toBe(0);
        regionModule.release();
        await page.locator(".side-panel-empty__types").waitFor({ state: "visible" });
        await openChatSidePanelType(page, "Browser");
        const browser = page.locator("openclaw-browser-panel");
        await expect.poll(() => browser.isVisible()).toBe(true);
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
        await settled();
        await captureUiProof(suite, page, "floating-progress", "with-browser-collapsed.png");
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        await settled();
        const bounds = await floating.boundingBox();
        const browserBounds = await browser.boundingBox();
        const composerBounds = await page.locator(".agent-chat__input").boundingBox();
        expect(bounds).not.toBeNull();
        expect(browserBounds).not.toBeNull();
        expect(composerBounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(browserBounds!.x);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(composerBounds!.y);
        await captureUiProof(suite, page, "floating-progress", "with-browser-expanded.png");
        await floating.getByRole("button", { name: "Refresh task progress", exact: true }).click();
        await expect.poll(() => gateway.getRequests("progressCard.refresh")).toHaveLength(1);
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey,
            revision: 2,
            updatedAt: Date.now(),
            markdown: "The latest shutdown check is in progress.",
            steps: [{ step: "Verify the shutdown boundary", status: "in_progress" }],
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(() => floating.textContent())
          .toContain("The latest shutdown check is in progress.");
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey,
            revision: 3,
            updatedAt: Date.now(),
            markdown: "Long progress remains scrollable without covering the composer.",
            steps: Array.from({ length: 30 }, (_, index) => ({
              step: `Verification step ${index + 1}`,
              status: "pending",
            })),
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 3 });
        await expect.poll(() => floating.textContent()).toContain("Verification step 30");
        await page.setViewportSize({ width: 1440, height: 620 });
        await settled();
        const progressBody = floating.locator(".session-progress-card__body");
        const bodySize = await progressBody.evaluate((element) => ({
          height: element.clientHeight,
          content: element.scrollHeight,
        }));
        expect(bodySize.content).toBeGreaterThan(bodySize.height);
        const lastStep = floating.locator(".session-progress-card__step").last();
        await lastStep.scrollIntoViewIfNeeded();
        const lastBounds = await lastStep.boundingBox();
        const bodyBounds = await progressBody.boundingBox();
        expect(lastBounds!.y + lastBounds!.height).toBeLessThanOrEqual(
          bodyBounds!.y + bodyBounds!.height + 1,
        );
        const longBounds = await floating.boundingBox();
        const shortComposer = await page.locator(".agent-chat__input").boundingBox();
        expect(longBounds!.y + longBounds!.height).toBeLessThanOrEqual(shortComposer!.y);
        await captureUiProof(suite, page, "floating-progress", "long-progress-scrolled.png");
        await toggle.focus();
        await page.keyboard.press("Escape");
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
        await settled();
        await page
          .locator('[data-region-header="side"]')
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect.poll(() => browser.isVisible()).toBe(false);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await draft.inputValue()).toBe("Keep this draft while panels change.");
        const closedBrowserLayout = await savedLayouts();
        await page.setViewportSize({ width: 560, height: 900 });
        await expect.poll(() => card.isVisible()).toBe(true);
        expect(await floating.count()).toBe(0);
        await captureUiProof(suite, page, "floating-progress", "narrow-fallback.png");
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expect.poll(() => floating.isVisible()).toBe(true);
        expect(await card.count()).toBe(0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        const runningAnimations = await floating.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length,
        );
        expect(runningAnimations).toBe(0);
        await page.getByRole("button", { name: "Hide task progress", exact: true }).click();
        await expect.poll(() => floating.count()).toBe(0);
        expect(await card.count()).toBe(0);
        expect(await savedLayouts()).toEqual(closedBrowserLayout);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        await page.reload();
        await draft.waitFor();
        expect(await floating.count()).toBe(0);
        expect(await card.count()).toBe(0);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        const preferences = await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          settingsKey,
        );
        expect(preferences.chatShowTaskProgress).toBe(false);
        expect(preferences.chatFloatTaskProgress).toBe(true);
        await row("Show task progress cards").click();
        await expect.poll(() => floating.isVisible()).toBe(true);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await settingsGateway.getRequests("config.patch")).toHaveLength(0);
        await settingsPage.close();
      },
    );
  });
});
