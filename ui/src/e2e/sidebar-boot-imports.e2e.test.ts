import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import { sidebarPresentationProbe } from "../test-helpers/control-ui-sidebar-presentation-probe.test-support.ts";
import {
  installSidebarCachedParitySettings,
  installTeamScaleSidebarPresentation,
} from "../test-helpers/control-ui-sidebar-presentation.test-support.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Sidebar optional boot imports",
});

suite.define(() => {
  it("restores cached sidebar rows while a peer resolves its profile", async () => {
    const fixture = createControlUiTeamScaleFixture({
      baseUrl: suite.server.baseUrl,
      sidebarCachedParity: true,
    });
    const archived = fixture.scenario.sessions![1]!;
    archived.archived = true;
    const lists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1719, height: 1179 } },
      async ({ page, context }) => {
        await context.route("**/*", (route) => {
          const asset = fixture.assets.get(new URL(route.request().url()).pathname);
          return asset
            ? route.fulfill({ status: 200, body: asset.body, contentType: asset.contentType })
            : route.fallback();
        });
        await context.addInitScript(
          installSidebarCachedParitySettings,
          fixture.scenario.sessionGroups ?? [],
        );
        await context.addInitScript(
          ({ key, entries }) => {
            if (!localStorage.getItem(key)) {
              localStorage.setItem(
                key,
                JSON.stringify({
                  sidebarAgentsMode: "chip",
                  railShortcuts: entries,
                  navigationByProfile: { "team-person-001": { railShortcuts: entries } },
                }),
              );
            }
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            entries: fixture.sidebarEntries,
          },
        );
        const install = (target: typeof page, unresolved = false) =>
          installMockGateway(
            target,
            unresolved
              ? {
                  ...fixture.scenario,
                  presenceUsers: fixture.scenario.presenceUsers!.filter((user) => !user.self),
                  heldMethods: ["users.self"],
                }
              : { ...fixture.scenario, heldMethods: ["connect"] },
            {
              afterInitScript: `(${sidebarPresentationProbe.toString()})(); (${installTeamScaleSidebarPresentation.toString()})(${JSON.stringify(fixture.sidebarPresentation)});`,
              requestHandlers: {
                "sessions.list": (value) => {
                  const params = asRecord(value);
                  if (!params) {
                    throw new Error("sessions.list requires query parameters");
                  }
                  return lists.list(params).result;
                },
                "cron.list": (value) => fixture.listCronJobs(asRecord(value) ?? {}),
              },
            },
          );
        const gateway = await install(page);
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, "chat"),
        );
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        await page.locator("aside.sidebar img").evaluateAll(async (images) => {
          await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
        });
        await page.locator("aside.sidebar .is-pending").first().waitFor({ state: "hidden" });
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        const peer = await context.newPage();
        const peerGateway = await install(peer, true);
        await peer.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key, "chat"));
        await peerGateway.waitForRequest("users.self");
        await evaluateControlUiContext(peer, async (app) => {
          await app.agents.ensureList();
          await app.sessions.groupsLoad();
          if (app.gateway.snapshot.selfUser !== undefined) {
            throw new Error("The peer's profile must still be unresolved");
          }
        });
        // Flush the peer's native pending publication before reloading another route.
        await peer.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        for (const face of ["chat", "dashboard"] as const) {
          await page.goto(
            controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, face),
          );
          await gateway.waitForRequest("connect");
          await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
          await page.locator(".sidebar-recent-session").nth(10).waitFor();
          await page
            .locator("aside.sidebar")
            .screenshot({ path: path.join(suite.artifactDir, `${face}-cached.png`) });
          await gateway.resolveDeferred("connect");
          await page
            .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
            .waitFor();
          const report = await page.evaluate(() =>
            Reflect.get(window, "__sidebarPresentation").read(),
          );
          await writeFile(
            path.join(suite.artifactDir, `${face}-parity.json`),
            JSON.stringify(report, null, 2),
          );
          expect(report.parity?.initialRows).toBeGreaterThan(0);
          expect(report.parity).toMatchObject({ added: 0, removed: 0, avatars: 0 });
          expect(await page.locator(".sidebar-footer-bar__home").isEnabled()).toBe(true);
          await page
            .locator("aside.sidebar")
            .screenshot({ path: path.join(suite.artifactDir, `${face}-live.png`) });
        }
        const scrolled = await page.evaluate(async () => {
          const scroller = document.querySelector<HTMLElement>(".sidebar-shell__body")!;
          const saved = new Promise<number>((resolve) => {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, key) {
              const request = put.call(this, value, key);
              if (this.name === "sidebarSnapshots" && value.model) {
                IDBObjectStore.prototype.put = put;
                this.transaction.addEventListener("complete", () => resolve(scroller.scrollTop), {
                  once: true,
                });
              }
              return request;
            };
          });
          scroller.scrollTop = 1400;
          scroller.dispatchEvent(new Event("scroll"));
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          window.dispatchEvent(new Event("pagehide"));
          return saved;
        });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const scrollPresentation = await page.evaluate(() =>
          Reflect.get(window, "__sidebarPresentation").read(),
        );
        await writeFile(
          path.join(suite.artifactDir, "scroll-presentation.json"),
          JSON.stringify(scrollPresentation, null, 2),
        );
        const first = scrollPresentation.frames.find((frame: { cached: boolean }) => frame.cached);
        expect(first?.mountedKeys.length).toBeGreaterThan(0);
        expect(first?.rows.length).toBeGreaterThan(0);
        const restored = await page
          .locator(".sidebar-shell__body")
          .evaluate((element) => element.scrollTop);
        const bytes = await page.evaluate(async () => {
          const request = indexedDB.open("openclaw-chat-snapshots");
          const database = await new Promise<IDBDatabase>((resolve) =>
            request.addEventListener("success", () => resolve(request.result), { once: true }),
          );
          const records = database
            .transaction("sidebarSnapshots")
            .objectStore("sidebarSnapshots")
            .getAll();
          const values = await new Promise<Array<{ model: unknown }>>((resolve) =>
            records.addEventListener("success", () => resolve(records.result), { once: true }),
          );
          database.close();
          return values.map((value) => ({
            modelBytes: new TextEncoder().encode(JSON.stringify(value.model)).length,
            recordBytes: new TextEncoder().encode(JSON.stringify(value)).length,
          }));
        });
        await writeFile(
          path.join(suite.artifactDir, "scroll-bytes.json"),
          JSON.stringify({ scrolled, restored, bytes }),
        );
        expect(restored).toBe(scrolled);
        expect(
          await evaluateControlUiContext(page, (app) => app.gateway.snapshot.hello),
        ).toBeNull();
        const beforeHome = page.url();
        await page.locator(".sidebar-footer-bar__home").click();
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(page.url()).not.toBe(beforeHome);
        await page.locator(".sidebar-rail__button.sidebar-new-session").click();
        await page.locator(".new-session-page").waitFor();
      },
    );
  });

  it("loads the Inbox renderer on interaction while keeping its badge available at boot", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const panelRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.includes("/sidebar-attention-panel.runtime-")) {
          panelRequests.push(request.url());
        }
      });
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const inbox = page.locator(".sidebar-issues-button");
      await inbox.waitFor();
      expect(panelRequests).toHaveLength(0);
      await inbox.click();
      await page.locator(".sidebar-issues-panel").waitFor();
      expect(panelRequests).toHaveLength(1);
      expect(await inbox.getAttribute("aria-expanded")).toBe("true");
    });
  });
});
