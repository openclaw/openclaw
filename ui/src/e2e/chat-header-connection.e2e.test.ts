import path from "node:path";
import { expect, it } from "vitest";
import { installPaneChromeProbe } from "../../../scripts/lib/control-ui-pane-chrome-probe.ts";
import { warmReloadProbe } from "../../../scripts/lib/control-ui-warm-reload-probe.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header connection feedback" });

suite.define(() => {
  it.each(["chat", "dashboard"] as const)(
    "keeps cached %s header geometry through a slow or failed connection",
    async (face) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const fixture = createControlUiTeamScaleFixture({
          baseUrl: suite.server.baseUrl,
          transcriptMessages: 4,
          archivedSession: true,
          offRosterSession: true,
          paneChromeFacts: true,
        });
        const sessionKey = fixture.selectedSessionKey;
        await page.addInitScript((entries) => {
          if (window !== window.top || location.protocol === "about:") {
            return;
          }
          for (const [key, value] of Object.entries(entries)) {
            if (localStorage.getItem(key) === null) {
              localStorage.setItem(key, value);
            }
          }
        }, fixture.paneChromeSettings);
        await page.route("**/__openclaw__/**", async (route) => {
          const asset = fixture.assets.get(new URL(route.request().url()).pathname);
          if (asset) {
            await route.fulfill({ status: 200, ...asset });
          } else {
            await route.fallback();
          }
        });
        const gateway = await installMockGateway(
          page,
          {
            ...fixture.scenario,
            sessionArchiveFiltering: true,
            heldMethods: ["connect", "sessions.branches.list"],
          },
          {
            afterInitScript: `;globalThis.__name = (fn) => fn; globalThis.__paneChrome = (${installPaneChromeProbe.toString()})(); (${warmReloadProbe.toString()})({}, __paneChrome.sample);`,
          },
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, face));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("sessions.branches.list");
        await gateway.resolveDeferred("sessions.branches.list");
        const conversation = page.getByText("Project checkpoint 4", { exact: true }).first();
        await conversation.waitFor();
        await expect
          .poll(() =>
            page.evaluate(async () => {
              if (
                !(await indexedDB.databases()).some((db) => db.name === "openclaw-chat-snapshots")
              ) {
                return false;
              }
              const result = <T>(request: IDBRequest<T>) =>
                new Promise<T>((resolve, reject) => {
                  request.addEventListener("success", () => resolve(request.result));
                  request.addEventListener("error", () =>
                    reject(request.error ?? new Error("Snapshot request failed")),
                  );
                });
              const db = await result(indexedDB.open("openclaw-chat-snapshots"));
              try {
                return (
                  (await result(db.transaction("snapshots").objectStore("snapshots").count())) >
                    0 &&
                  Object.keys(localStorage).some((key) =>
                    key.startsWith("openclaw.control.bootRecord.v1:"),
                  )
                );
              } finally {
                db.close();
              }
            }),
          )
          .toBe(true);
        const header = page.locator(".chat-pane-cache__pane--visible .chat-pane__header").first();
        const status = header.locator(".chat-pane__connection");
        const geometry = () =>
          header
            .locator(
              ".chat-pane__header-trailing, .chat-pane__identity-actions, .chat-pane__crumbs, .chat-pane__session-title-text",
            )
            .evaluateAll((elements) =>
              elements.map((element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
              }),
            );
        const footer = page.locator(".chat-group.user .chat-group-footer__meta").first();
        const footerGeometry = () =>
          footer.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const row = element.closest(".chat-group")!.getBoundingClientRect();
            return [box.x - row.x, box.width, box.height];
          });
        await header.locator(".chat-pane__workspace-chip").waitFor();
        await header.locator(".session-color-dot").waitFor();
        await header.locator("openclaw-chat-pane-versions-menu").waitFor();
        const settled = await geometry();
        const settledFooter = await footerGeometry();
        await page.evaluate(async () => {
          const pane = document.querySelector(".chat-pane-cache__pane--active")!;
          await Reflect.get(pane, "sessionSnapshotStore").flush();
        });
        const capture = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({ path: path.join(suite.artifactDir, `${face}-${name}.png`) });
          }
        };

        await page.clock.install();
        await page.reload({ waitUntil: "domcontentloaded" });
        await gateway.waitForRequest("connect");
        await conversation.waitFor();
        await capture("boot");
        expect(await status.count()).toBe(0);
        expect(await header.locator(".chat-header-session-menu__trigger").count()).toBe(0);
        const before = await geometry();
        expect.soft(before).toEqual(settled);
        expect.soft(await footerGeometry()).toEqual(settledFooter);
        await page.clock.fastForward(2_000);
        await status.waitFor({ state: "visible" });
        expect.soft(await geometry()).toEqual(before);
        expect(
          await status.evaluate((element) => {
            const indicator = element.getBoundingClientRect();
            const bounds = element.closest(".chat-pane__header")!.getBoundingClientRect();
            return indicator.top >= bounds.top && indicator.bottom <= bounds.bottom;
          }),
        ).toBe(true);
        await capture("slow");
        await gateway.resolveDeferred("connect");
        await status.waitFor({ state: "hidden" });
        await header.locator(".chat-header-session-menu__trigger").waitFor();
        await gateway.waitForRequest("sessions.branches.list");
        expect.soft(await geometry()).toEqual(before);
        await gateway.resolveDeferred("sessions.branches.list");
        await header.locator("openclaw-chat-pane-versions-menu").waitFor();
        expect.soft(await footerGeometry()).toEqual(settledFooter);
        expect.soft(await geometry()).toEqual(before);
        await capture("connected");
        const frames = await page.evaluate(
          () => Reflect.get(window, "__paneChrome").read(0).frames,
        );
        for (const region of [
          "headerTrailing",
          "headerIdentity",
          "identity",
          "sessionTitle",
          "ownFooter",
        ]) {
          const boxes: number[][] = frames.flatMap(
            (frame: { boxes: Record<string, number[] | null> }) =>
              frame.boxes[region] ? [frame.boxes[region]] : [],
          );
          expect(boxes.length).toBeGreaterThan(0);
          for (const box of boxes) {
            for (const axis of [0, 2]) {
              expect(Math.abs(box[axis]! - boxes[0]![axis]!)).toBeLessThanOrEqual(1);
            }
          }
        }

        await gateway.setOnline(false);
        await status.waitFor({ state: "visible" });
        expect(await conversation.isVisible()).toBe(true);
        expect.soft(await geometry()).toEqual(before);
        await capture("offline");
      });
    },
  );
});
