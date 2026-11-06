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
  it("restores ordinary child activity in the first populated Details frame without moving later sections", async () => {
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
        const children = fixture.scenario.sessions!.filter(
          (row) =>
            row.parentSessionKey === sessionKey && row.label?.startsWith("Synthetic child review "),
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
        await group.getByText(children[0]!.label!, { exact: true }).waitFor();
        await group.getByText(children[1]!.label!, { exact: true }).waitFor();
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
            if (panel?.querySelector("section.chat-details-session")?.checkVisibility()) {
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
        await page.reload();
        await gateway.waitForRequest("connect");
        await details.locator("section.chat-details-session").waitFor();
        const first = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          return (Reflect.get(window, "childActivityReloadFrames") as DetailsFrame[])[0]!;
        });
        expect(first.sections.some((section) => section.id === "subagents")).toBe(true);
        expect(first.rows).toBe(2);
        expect(first.labels).toEqual(children.map((row) => row.label));
        expect(
          await group.locator("button.chat-subagent-activity__row:not(:disabled), a").count(),
        ).toBe(0);
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
        const frames = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          return Reflect.get(window, "childActivityReloadFrames") as DetailsFrame[];
        });
        const final = frames.at(-1)!;
        expect(final.sections.map((section) => section.id)).toEqual([
          "subagents",
          "outputs",
          "automations",
        ]);
        for (const frame of frames) {
          expect(frame.rows).toBe(2);
          expect(frame.sections.map((section) => section.id)).toEqual(
            final.sections.map((section) => section.id),
          );
          frame.sections.forEach((section, index) => {
            expect(
              Math.abs(section.height - final.sections[index]!.height),
              section.id,
            ).toBeLessThanOrEqual(1);
            expect(
              Math.abs(section.top - final.sections[index]!.top),
              section.id,
            ).toBeLessThanOrEqual(1);
          });
        }
      },
    );
  });
});
