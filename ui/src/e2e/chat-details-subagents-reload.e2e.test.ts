import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { dashboardLayout } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type DetailsFrame = {
  rows: number;
  labels: string[];
  sections: Array<{ id: string; top: number; height: number }>;
};

const suite = createControlUiE2eSuite({ name: "Details ordinary child activity warm reload" });
suite.define(() => {
  it.each([false, true])(
    "keeps cached Details usable on reload (activity module failure: %s)",
    async (failActivity) => {
      await suite.withPage(
        { viewport: { width: 2200, height: 1180 }, serviceWorkers: "block" },
        async ({ page }) => {
          const fixture = createControlUiTeamScaleFixture({
            baseUrl: suite.server.baseUrl,
            transcriptMessages: 15,
            paneChromeFacts: true,
            detailsSessionFacts: true,
            detailsSubagentActivity: 2,
          });
          const sessionKey = fixture.selectedSessionKey;
          const childLabels = fixture.scenario.sessions!.flatMap(({ parentSessionKey, label }) =>
            parentSessionKey === sessionKey &&
            typeof label === "string" &&
            label.startsWith("Synthetic child review ")
              ? [label]
              : [],
          );
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
                "cron.list": (params) => fixture.listCronJobs(isRecord(params) ? params : {}),
              },
            },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          const details = await openChatDetails(page);
          const group = details.locator('[data-details-group="subagents"]');
          await group.getByText(childLabels[0]!, { exact: true }).waitFor();
          await group.getByText(childLabels[1]!, { exact: true }).waitFor();
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
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Reflect.get(
              document.querySelector(".chat-pane-cache__pane--active")!,
              "sessionSnapshotStore",
            ).flush();
          });
          await page.addInitScript(() => {
            const frames: DetailsFrame[] = [];
            const sample = () => {
              const panel = document.querySelector(".chat-pane-cache__pane--active .chat-details");
              if (panel?.querySelector("[data-details-group]")?.checkVisibility()) {
                const top = panel.getBoundingClientRect().top;
                frames.push({
                  rows: panel.querySelectorAll(".chat-subagent-activity__row").length,
                  labels: [...panel.querySelectorAll(".chat-subagent-activity__name")].map(
                    (name) => name.textContent ?? "",
                  ),
                  sections: [
                    ...panel.querySelectorAll(
                      '[data-details-group="subagents"], [data-details-group="outputs"], [data-details-group="automations"]',
                    ),
                  ].map((section) => {
                    const box = section.getBoundingClientRect();
                    return {
                      id: section.getAttribute("data-details-group")!,
                      top: box.top - top,
                      height: box.height,
                    };
                  }),
                });
              }
              requestAnimationFrame(sample);
            };
            Reflect.set(window, "childActivityReloadFrames", frames);
            requestAnimationFrame(sample);
          });
          const readFrames = () =>
            page.evaluate(async () => {
              await new Promise(requestAnimationFrame);
              return Reflect.get(window, "childActivityReloadFrames") as DetailsFrame[];
            });
          const activityRequested = page.waitForRequest(
            "**/assets/chat-subagent-activity-live-*.js",
          );
          const activityRelease = Promise.withResolvers<void>();
          await page.route("**/assets/chat-subagent-activity-live-*.js", (route) =>
            failActivity ? route.abort() : activityRelease.promise.then(() => route.continue()),
          );
          await page.reload({ waitUntil: "domcontentloaded" });
          await activityRequested;
          await gateway.waitForRequest("connect");
          if (failActivity) {
            await details.locator('[data-details-group="outputs"]').waitFor();
            await details.locator('[data-details-group="automations"]').waitFor();
            await group.locator(".lazy-view-error").waitFor();
            await group.getByRole("button", { name: "Reload", exact: true }).waitFor();
            expect(await details.locator(".lazy-view-error").count()).toBe(1);
            await gateway.resolveDeferred("connect");
            return;
          }
          try {
            await details.locator("section.chat-details-session").waitFor();
            const first = (await readFrames())[0]!;
            expect(first.sections.some((section) => section.id === "subagents")).toBe(true);
            expect(first.rows).toBe(2);
            expect(first.labels).toEqual(childLabels);
            expect(
              await group.locator("button.chat-subagent-activity__row:not(:disabled), a").count(),
            ).toBe(0);
          } finally {
            activityRelease.resolve();
          }
          await gateway.resolveDeferred("connect");
          await group.locator("button.chat-subagent-activity__row").first().waitFor();
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
          const frames = await readFrames();
          const final = frames.at(-1)!;
          const sectionIds = ["subagents", "outputs", "automations"];
          expect(final.sections.map((section) => section.id)).toEqual(sectionIds);
          for (const frame of frames) {
            expect(frame.rows).toBe(2);
            expect(frame.sections.map((section) => section.id)).toEqual(sectionIds);
            frame.sections.forEach((section, index) => {
              for (const dimension of ["height", "top"] as const) {
                expect(
                  Math.abs(section[dimension] - final.sections[index]![dimension]),
                  `${section.id} ${dimension}`,
                ).toBeLessThanOrEqual(1);
              }
            });
          }
        },
      );
    },
  );
});
