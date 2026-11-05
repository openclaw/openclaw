import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { dashboardLayout } from "./chat-layout-fixtures.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details progress warm reload" });
suite.define(() => {
  it.each([
    { face: "chat", archived: false, delayedEnvironment: false },
    { face: "dashboard", archived: false, delayedEnvironment: false },
    { face: "chat", archived: true, delayedEnvironment: false },
    { face: "chat", archived: false, delayedEnvironment: true },
  ] as const)(
    "restores final Details geometry on $face (archived=$archived, delayedEnvironment=$delayedEnvironment) until live facts differ",
    async ({ face, archived, delayedEnvironment }) => {
      await suite.withPage(
        { viewport: { width: 2200, height: 1180 }, serviceWorkers: "block" },
        async ({ page }) => {
          const fixture = createControlUiTeamScaleFixture({
            baseUrl: suite.server.baseUrl,
            transcriptMessages: 15,
            paneChromeFacts: true,
            detailsSessionFacts: true,
          });
          const sessionKey = fixture.selectedSessionKey;
          const selectedSession = fixture.scenario.sessions!.find((row) => row.key === sessionKey)!;
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
            {
              ...fixture.scenario,
              featureMethods: [...fixture.scenario.featureMethods!, "sessions.processes.list"],
              methodResponses: {
                ...fixture.scenario.methodResponses,
                "sessions.processes.list": {
                  sessionId: selectedSession.sessionId,
                  processes: archived
                    ? []
                    : [
                        {
                          processId: "verification",
                          instanceId: "verification-1",
                          name: "Synthetic verifier",
                          status: "running",
                          startedAt: 1,
                          tail: "ready",
                          truncated: false,
                          canStop: true,
                        },
                      ],
                  truncated: false,
                },
              },
              deferredMethods: ["connect"],
            },
            {
              requestHandlers: {
                "cron.list": (params) => fixture.listCronJobs(isRecord(params) ? params : {}),
              },
            },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, face));
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          const details = await openChatDetails(page);
          const progress = details.locator('[data-progress-card-placement="details"]');
          await progress.getByText("Synthetic project verification is in progress.").waitFor();
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
          if (archived) {
            const archivedSession = { ...selectedSession, archived: true };
            await gateway.setSessionsListResponse(
              sessionsListResponse(
                fixture.scenario.sessions!.map((row) =>
                  row.key === sessionKey ? archivedSession : row,
                ),
              ),
            );
            await gateway.emitGatewayEvent("sessions.changed", {
              ...archivedSession,
              reason: "patch",
              sessionKey,
            });
            await progress.waitFor({ state: "hidden" });
            await page.waitForFunction(() => {
              const pane = document.querySelector(".chat-pane-cache__pane--active");
              const cache = pane && Reflect.get(pane, "state")?.chatMessagesBySession;
              return (
                cache &&
                [...cache.values()].some(
                  ({ snapshot }) =>
                    snapshot.sessionState?.archived === true && snapshot.progressCard,
                )
              );
            });
          }
          const loaded = archived ? null : await progress.textContent();
          await details.getByText("feature/verification", { exact: true }).waitFor();
          if (!archived) {
            await details.locator('[data-details-group="processes"]').waitFor();
          }
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await waitForLayoutSettled(page, '.chat-details [data-details-group="environment"]');
          const environmentHeight = (await details
            .locator('[data-details-group="environment"]')
            .boundingBox())!.height;
          await page.evaluate(async () => {
            await Reflect.get(
              document.querySelector(".chat-pane-cache__pane--active")!,
              "sessionSnapshotStore",
            ).flush();
          });
          await page.addInitScript(() => {
            const dockFlips: string[] = [];
            new MutationObserver((records) => {
              for (const record of records) {
                if (
                  record.target instanceof Element &&
                  record.target.matches(".chat-details--docked") &&
                  record.attributeName === "class" &&
                  record.oldValue?.split(" ").includes("chat-details") &&
                  !record.oldValue.split(" ").includes("chat-details--docked")
                ) {
                  dockFlips.push(record.oldValue);
                }
              }
            }).observe(document, {
              attributes: true,
              attributeFilter: ["class"],
              attributeOldValue: true,
              subtree: true,
            });
            Reflect.set(window, "detailsDockFlips", dockFlips);
            const frames: Array<{
              details: boolean;
              environment: string | null;
              progress: string | null;
              sections: Array<{ id: string; top: number; height: number }>;
            }> = [];
            const sample = () => {
              const pane = document.querySelector(".chat-pane-cache__pane--active");
              const panel = pane?.querySelector(".chat-details");
              const session = panel?.querySelector("section.chat-details-session");
              if (pane?.querySelector(".chat-pane__header")?.checkVisibility()) {
                const top = panel?.getBoundingClientRect().top ?? 0;
                frames.push({
                  details: Boolean(session?.checkVisibility()),
                  environment:
                    panel?.querySelector(".chat-environment__branch-name")?.textContent ?? null,
                  progress:
                    panel?.querySelector('[data-progress-card-placement="details"]')?.textContent ??
                    null,
                  sections: [
                    ...(panel?.querySelectorAll(
                      "section.chat-details-session, [data-details-group], [data-progress-card-placement='details']",
                    ) ?? []),
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
          const [environmentModule, compositionModule] = delayedEnvironment
            ? await Promise.all(
                [
                  "ui/src/pages/chat/components/chat-details-environment-body.tsx",
                  "ui/src/pages/chat/components/chat-details-session.tsx",
                ].map((source) => holdModuleResponse(page, controlUiE2eBuiltModuleRequest(source))),
              )
            : [];
          await page.reload({ waitUntil: "domcontentloaded" });
          if (environmentModule && compositionModule) {
            // Let the pane paint after Desktop arrives while Environment is still in flight.
            await compositionModule.request;
            compositionModule.release();
            await environmentModule.request;
            await page.locator(".chat-pane-cache__pane--active .chat-pane__header").waitFor();
            await page.evaluate(
              () =>
                new Promise((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(resolve));
                }),
            );
            environmentModule.release();
          }
          await gateway.waitForRequest("connect");
          await details.locator("section.chat-details-session").waitFor();
          if (archived) {
            expect(await progress.count()).toBe(0);
          }
          if (!archived) {
            await progress.getByText("Synthetic project verification is in progress.").waitFor();
            expect(await details.locator(".chat-details-processes__stop").count()).toBe(0);
            if (face === "chat" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const capture = await takeControlUiScreenshotFrame(page, details, [], {
                elements: [details],
              });
              await writeFile(
                path.join(suite.artifactDir, "active-warm-details.png"),
                capture.elements[0]!.png,
              );
            }
          }
          if (!delayedEnvironment) {
            await gateway.resolveDeferred("connect");
          }
          await details.getByText("feature/verification", { exact: true }).waitFor();
          if (!archived) {
            await details.locator('[data-details-group="processes"]').waitFor();
          }
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
          const captured = await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            return Reflect.get(window, "progressReloadFrames") as Array<{
              details: boolean;
              environment: string | null;
              progress: string | null;
              sections: Array<{ id: string; top: number; height: number }>;
            }>;
          });
          const frames = delayedEnvironment ? captured.filter((frame) => frame.details) : captured;
          expect(frames.length).toBeGreaterThan(1);
          expect(await page.evaluate(() => Reflect.get(window, "detailsDockFlips"))).toEqual([]);
          expect(frames[0]!.details).toBe(true);
          expect(frames[0]!.environment).toBe("feature/verification");
          expect(
            Math.abs(
              frames[0]!.sections.find((section) => section.id === "environment")!.height -
                environmentHeight,
            ),
            `Cached Environment height ${environmentHeight}; first populated frame ${JSON.stringify(frames[0]!.sections)}`,
          ).toBeLessThanOrEqual(1);
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
          if (delayedEnvironment) {
            await gateway.resolveDeferred("connect");
            return;
          }
          if (!archived && face === "chat") {
            await details.locator(".chat-details-processes__stop").waitFor();
            await gateway.deferNext("sessions.processes.list");
            await gateway.emitGatewayEvent("sessions.processes.changed", { sessionKey });
            await gateway.rejectDeferred("sessions.processes.list", {
              code: "FORBIDDEN",
              message: "Process access removed",
            });
            await details.getByRole("alert").getByText("Process access removed").waitFor();
            expect(await details.locator('[data-details-group="processes"]').count()).toBe(0);
            await gateway.deferNext("sessions.processes.list");
            await page.evaluate(() => {
              Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "hidden",
              });
              document.dispatchEvent(new Event("visibilitychange"));
              Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "visible",
              });
              document.dispatchEvent(new Event("visibilitychange"));
            });
            await gateway.waitForRequest("sessions.processes.list");
            await details.getByRole("alert").getByText("Process access removed").waitFor();
            expect(await details.locator('[data-details-group="processes"]').count()).toBe(0);
            await page.evaluate(() => {
              Reflect.deleteProperty(document, "visibilityState");
              document.dispatchEvent(new Event("visibilitychange"));
            });
            await gateway.resolveDeferred("sessions.processes.list");
            await details.locator(".chat-details-processes__stop").waitFor();
            await gateway.setMethodResponse("sessions.processes.list", {
              sessionId: selectedSession.sessionId,
              processes: [],
              truncated: false,
            });
            await gateway.emitGatewayEvent("sessions.processes.changed", { sessionKey });
            await page.waitForFunction(() => {
              const pane = document.querySelector(".chat-pane-cache__pane--active");
              const cache = pane && Reflect.get(pane, "state")?.chatMessagesBySession;
              return (
                cache &&
                [...cache.values()].some(({ snapshot }) => snapshot.details?.processes?.total === 0)
              );
            });
            expect(await details.locator('[data-details-group="processes"]').count()).toBe(0);
          }
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
