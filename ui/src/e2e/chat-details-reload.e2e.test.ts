import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { dashboardLayout } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details progress warm reload" });
suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "retains cached %s progress until live facts differ",
    async (face) => {
      await suite.withPage(
        { viewport: { width: 2200, height: 1180 }, serviceWorkers: "block" },
        async ({ page }) => {
          const fixture = createControlUiTeamScaleFixture({
            baseUrl: suite.server.baseUrl,
            transcriptMessages: 15,
          });
          const sessionKey = fixture.selectedSessionKey;
          await page.addInitScript(
            ({ key, settings }) => {
              if (!localStorage.getItem(key)) {
                localStorage.setItem(key, JSON.stringify(settings));
              }
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              settings: {
                sessionKey,
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
          await page.evaluate(async () => {
            await Reflect.get(
              document.querySelector(".chat-pane-cache__pane--active")!,
              "sessionSnapshotStore",
            ).flush();
          });
          const loaded = await progress.textContent();
          await page.addInitScript(() => {
            const frames: string[] = [];
            const sample = () => {
              const card = document.querySelector(
                '.chat-pane-cache__pane--active [data-progress-card-placement="details"]',
              );
              if (card?.checkVisibility()) {
                frames.push(card.textContent ?? "");
              }
              requestAnimationFrame(sample);
            };
            Reflect.set(window, "progressReloadFrames", frames);
            requestAnimationFrame(sample);
          });
          await page.reload();
          await gateway.waitForRequest("connect");
          await progress.getByText("Synthetic project verification is in progress.").waitFor();
          await gateway.resolveDeferred("connect");
          await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
          const frames = await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            return Reflect.get(window, "progressReloadFrames") as string[];
          });
          expect(new Set(frames)).toEqual(new Set([loaded]));
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
