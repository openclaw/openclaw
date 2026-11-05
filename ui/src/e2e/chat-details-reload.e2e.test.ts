import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { dashboardLayout } from "./chat-layout-fixtures.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details progress warm reload" });
suite.define(() => {
  it.each([
    { face: "chat", archived: false },
    { face: "dashboard", archived: false },
    { face: "chat", archived: true },
  ] as const)(
    "restores final Details geometry on $face (archived=$archived) until live facts differ",
    async ({ face, archived }) => {
      await suite.withPage(
        { viewport: { width: 2200, height: 1180 }, serviceWorkers: "block" },
        async ({ page }) => {
          const fixture = createControlUiTeamScaleFixture({
            baseUrl: suite.server.baseUrl,
            transcriptMessages: 15,
            archivedSession: archived,
            paneChromeFacts: true,
            detailsSessionFacts: true,
          });
          const sessionKey = fixture.selectedSessionKey;
          const sessions = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
          await page.addInitScript(
            ({ key, settings }) => {
              for (const [name, value] of Object.entries(settings.sidebarPrefs)) {
                localStorage.setItem(name, value);
              }
              if (!localStorage.getItem(key)) {
                localStorage.setItem(key, JSON.stringify(settings));
              }
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              settings: {
                sessionKey,
                sidebarPrefs: fixture.paneChromeSettings,
                sidebarSessionLayouts: {
                  [sessionKey]: dashboardLayout("side-panel-column", "dashboard", false),
                },
              },
            },
          );
          await page.route("**/__openclaw__/**", (route) => {
            const asset = fixture.assets.get(new URL(route.request().url()).pathname);
            return asset ? route.fulfill(asset) : route.fallback();
          });
          const gateway = await installMockGateway(
            page,
            { ...fixture.scenario, deferredMethods: ["connect"] },
            {
              requestHandlers: {
                "sessions.list": (params) => sessions.list(isRecord(params) ? params : {}).result,
                "cron.list": (params) => fixture.listCronJobs(isRecord(params) ? params : {}),
              },
            },
          );
          const url = controlUiSessionUrl(suite.server.baseUrl, sessionKey, face);
          if (face === "chat" && !archived) {
            const modules = await holdModuleResponse(page, /\/assets\/.*\.js(?:\?|$)/u);
            await page.goto(url, { waitUntil: "commit" });
            await modules.request;
            await expectBrowser(page.locator("#openclaw-boot-shell")).toBeVisible();
            modules.release();
          } else {
            await page.goto(url);
          }
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          const details = await openChatDetails(page);
          const progress = details.locator('[data-progress-card-placement="details"]');
          if (!archived) {
            await progress.getByText("Synthetic project verification is in progress.").waitFor();
          }
          await page.waitForFunction(() => {
            const pane = document.querySelector(".chat-pane-cache__pane--active");
            const cache = pane && Reflect.get(pane, "state")?.chatMessagesBySession;
            return (
              cache &&
              [...cache.values()].some(
                ({ snapshot }) => snapshot.details?.subagents && snapshot.details?.automations,
              )
            );
          });
          const loaded = archived ? null : await progress.textContent();
          await details.getByText("feature/verification", { exact: true }).waitFor();
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await expectBrowser(page.locator("aside.sidebar")).toHaveAttribute(
            "data-snapshot-saved",
            "true",
          );
          await page.evaluate(async () => {
            await Reflect.get(
              document.querySelector(".chat-pane-cache__pane--active")!,
              "sessionSnapshotStore",
            ).flush();
          });
          await page.addInitScript(() => {
            Reflect.set(window, "firstWarmAppFrame", null);
            const frames: Array<{
              progress: string | null;
              sections: Array<{ id: string; top: number; height: number }>;
            }> = [];
            const sample = () => {
              const visible = (selector: string) =>
                [...document.querySelectorAll(selector)].filter((element) =>
                  element.checkVisibility({ checkOpacity: true, visibilityProperty: true }),
                ).length;
              const first = {
                sidebar: visible("aside.sidebar [data-session-key]"),
                transcript: visible(".chat-virtual-row"),
                details: visible(".chat-details section.chat-details-session"),
                header: visible(".chat-pane__header"),
                composer: visible(".agent-chat__input, .agent-chat__disabled-banner--replacement"),
              };
              if (
                Reflect.get(window, "firstWarmAppFrame") === null &&
                Object.values(first).some((count) => count > 0)
              ) {
                Reflect.set(window, "firstWarmAppFrame", first);
              }
              const panel = document.querySelector(".chat-pane-cache__pane--active .chat-details");
              const session = panel?.querySelector("section.chat-details-session");
              if (panel && session?.checkVisibility()) {
                const top = panel.getBoundingClientRect().top;
                frames.push({
                  progress:
                    panel.querySelector('[data-progress-card-placement="details"]')?.textContent ??
                    null,
                  sections: [
                    ...panel.querySelectorAll(
                      "section.chat-details-session, [data-details-group], [data-progress-card-placement='details']",
                    ),
                  ].map((section) => {
                    const box = section.getBoundingClientRect();
                    return {
                      id:
                        section.getAttribute("data-details-group") ??
                        section.getAttribute("data-progress-card-placement") ??
                        "session",
                      top: box.top - top,
                      height: box.height,
                    };
                  }),
                });
              }
              requestAnimationFrame(sample);
            };
            Reflect.set(window, "progressReloadFrames", frames);
            requestAnimationFrame(sample);
          });
          const modules =
            face === "chat" && !archived
              ? await holdModuleResponse(page, /\/assets\/.*\.js(?:\?|$)/u)
              : undefined;
          await page.reload({ waitUntil: "commit" });
          if (modules) {
            await modules.request;
            await expectBrowser(page.locator("#openclaw-boot-shell")).toBeVisible();
            modules.release();
          }
          await gateway.waitForRequest("connect");
          if (!archived) {
            await progress.getByText("Synthetic project verification is in progress.").waitFor();
          }
          await gateway.resolveDeferred("connect");
          await details.getByText("feature/verification", { exact: true }).waitFor();
          await page.waitForFunction(() => {
            const panel = document.querySelector(".chat-pane-cache__pane--active .chat-details");
            return (
              panel &&
              !panel
                .getAnimations({ subtree: true })
                .some(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getTiming().iterations !== Infinity,
                )
            );
          });
          const frames = await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            return Reflect.get(window, "progressReloadFrames") as Array<{
              progress: string | null;
              sections: Array<{ id: string; top: number; height: number }>;
            }>;
          });
          const first = await page.evaluate(() => Reflect.get(window, "firstWarmAppFrame"));
          for (const region of ["sidebar", "transcript", "details", "header", "composer"]) {
            expect(first[region], `first visible app frame: ${region}`).toBeGreaterThan(0);
          }
          expect(frames.length).toBeGreaterThan(1);
          expect(frames[0]!.sections.some((section) => section.id === "automations")).toBe(true);
          const settled = frames.at(-1)!.sections;
          for (const frame of frames) {
            expect(frame.sections.map((section) => section.id)).toEqual(
              settled.map((section) => section.id),
            );
            frame.sections.forEach((section, index) => {
              expect(
                Math.abs(section.height - settled[index]!.height),
                section.id,
              ).toBeLessThanOrEqual(1);
              expect(Math.abs(section.top - settled[index]!.top), section.id).toBeLessThanOrEqual(
                1,
              );
            });
          }
          expect(new Set(frames.map((frame) => frame.progress))).toEqual(new Set([loaded]));
          if (archived) {
            return;
          }
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              sessionKey,
              revision: 2,
              updatedAt: Date.now(),
              steps: [{ step: "The live plan changed", status: "completed" }],
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
          await progress
            .getByText("The live plan changed")
            .filter({ visible: true })
            .first()
            .waitFor();
        },
      );
    },
  );
});
