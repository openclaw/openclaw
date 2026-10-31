import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details warm reload" });

suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "restores %s Details with the first cached pane before reconnect",
    async (face) => {
      await suite.withPage(
        { viewport: { width: 2200, height: 1180 }, serviceWorkers: "block" },
        async ({ page }) => {
          const fixture = createControlUiTeamScaleFixture({
            baseUrl: suite.server.baseUrl,
            transcriptMessages: 15,
            rowFacts: true,
          });
          if (face === "dashboard") {
            await page.addInitScript(
              ({ key, sessionKey }) => {
                if (!localStorage.getItem(key)) {
                  localStorage.setItem(
                    key,
                    JSON.stringify({
                      sessionKey,
                      sidebarSessionLayouts: {
                        [sessionKey]: {
                          columns: [
                            {
                              id: "side-panel-column",
                              side: "right",
                              panels: [{ id: "dashboard", slot: "dashboard" }],
                              activePanelId: "dashboard",
                              height: 360,
                              width: 320,
                            },
                          ],
                          dock: "right",
                          open: true,
                          expanded: false,
                        },
                      },
                    }),
                  );
                }
              },
              {
                key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
                sessionKey: fixture.selectedSessionKey,
              },
            );
          }
          await page.route("**/__openclaw__/**", (route) => {
            const asset = fixture.assets.get(new URL(route.request().url()).pathname);
            return asset ? route.fulfill(asset) : route.fallback();
          });
          const gateway = await installMockGateway(
            page,
            {
              ...fixture.scenario,
              deferredMethods: ["connect"],
            },
            {
              requestHandlers: {
                "cron.list": (params) => {
                  if (!isRecord(params)) {
                    throw new Error("Automation fixture requires query parameters");
                  }
                  return fixture.listCronJobs(params);
                },
              },
            },
          );
          await page.goto(
            controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, face),
          );
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          const details = await openChatDetails(page);
          await details.getByText("Synthetic project verification is in progress.").waitFor();
          await details.getByText("Synthetic scheduled check 1", { exact: true }).waitFor();
          await page.waitForFunction(() => window.openclawControlUi !== undefined);
          await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady);
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
          const settled = await details.evaluate((panel) => ({
            text: panel.textContent,
            height: panel.getBoundingClientRect().height,
            font: getComputedStyle(panel).font,
            fontReady: document.fonts.check(getComputedStyle(panel).font),
            sections: [...panel.querySelectorAll<HTMLElement>("[data-details-group]")].map(
              (section) => ({
                kind: section.dataset.detailsGroup,
                height: section.getBoundingClientRect().height,
                font: getComputedStyle(section.querySelector("summary")!).font,
              }),
            ),
          }));
          await page.screenshot({ path: `${suite.artifactDir}/${face}-loaded.png` });
          await page.addInitScript(() => {
            const frames: unknown[] = [];
            let active = true;
            const sample = () => {
              if (!active) {
                return;
              }
              const pane = document.querySelector(".chat-pane-cache__pane--active");
              if (pane?.querySelector(".agent-chat__composer-shell")?.checkVisibility()) {
                const panel = pane.querySelector(".chat-details");
                frames.push({
                  text: panel?.textContent ?? null,
                  height: panel?.getBoundingClientRect().height ?? 0,
                  font: panel ? getComputedStyle(panel).font : "",
                  fontReady: panel ? document.fonts.check(getComputedStyle(panel).font) : false,
                  sections: [
                    ...(panel?.querySelectorAll<HTMLElement>("[data-details-group]") ?? []),
                  ].map((section) => ({
                    kind: section.dataset.detailsGroup,
                    height: section.getBoundingClientRect().height,
                    font: getComputedStyle(section.querySelector("summary")!).font,
                  })),
                });
              }
              requestAnimationFrame(sample);
            };
            Reflect.set(window, "detailsReloadFrames", (stop = false) => {
              active = !stop;
              return frames;
            });
            requestAnimationFrame(sample);
          });
          await page.reload();
          await gateway.waitForRequest("connect");
          await page.locator(".chat-pane-cache__pane--active .chat-text").first().waitFor();
          const frames = await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            return Reflect.get(window, "detailsReloadFrames")() as (typeof settled)[];
          });
          await page.screenshot({ path: `${suite.artifactDir}/${face}-cached.png` });
          expect(frames.length).toBeGreaterThan(0);
          expect(frames).toEqual(frames.map(() => settled));
          await gateway.resolveDeferred("connect");
          await page.waitForFunction(
            () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
          );
          await gateway.waitForRequest("progressCard.get");
          await gateway.waitForRequest("sessions.list", {
            match: { spawnedBy: fixture.selectedSessionKey },
          });
          const liveFrames = await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return Reflect.get(window, "detailsReloadFrames")(true) as (typeof settled)[];
          });
          expect(liveFrames).toEqual(liveFrames.map(() => settled));
          expect(await details.textContent()).toBe(settled.text);
          const sessions = fixture.scenario.sessions.map((row) =>
            row.key === fixture.selectedSessionKey
              ? {
                  ...row,
                  status: "done",
                  endedAt: Date.now(),
                  hasActiveRun: false,
                  hasActiveSubagentRun: false,
                }
              : row,
          );
          await gateway.setSessionsListResponse({ sessions });
          await gateway.setMethodResponse("sessions.list", {
            cases: [
              {
                match: { spawnedBy: fixture.selectedSessionKey },
                response: {
                  __mockError: { code: "FORBIDDEN", message: "Synthetic child access denied" },
                },
              },
            ],
            fallback: { count: sessions.length, sessions, ts: Date.now(), defaults: {}, path: "" },
          });
          await page.reload();
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await details
            .getByText("No active work", { exact: true })
            .filter({ visible: true })
            .waitFor();
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              sessionKey: fixture.selectedSessionKey,
              revision: 2,
              updatedAt: Date.now(),
              steps: [{ step: "The live plan changed", status: "completed" }],
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: fixture.selectedSessionKey,
            revision: 2,
          });
          await details
            .getByText("The live plan changed")
            .filter({ visible: true })
            .first()
            .waitFor();
        },
      );
    },
  );
});
