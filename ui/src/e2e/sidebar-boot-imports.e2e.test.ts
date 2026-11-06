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

type RestoreTraceEvent = {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
};

function expectRestoreWithoutSynchronousLayout(events: RestoreTraceEvent[]) {
  const starts = events.filter((event) => event.name === "sidebar-restore-geometry-start");
  const ends = events.filter((event) => event.name === "sidebar-restore-geometry-end");
  expect(starts.length).toBeGreaterThan(0);
  expect(ends).toHaveLength(starts.length);
  const layout = events.filter(
    (event) => event.ph === "X" && ["Layout", "UpdateLayoutTree"].includes(event.name),
  );
  const synchronous = starts.flatMap((start, index) =>
    layout.filter(
      (event) =>
        event.pid === start.pid &&
        event.tid === start.tid &&
        event.ts < ends[index]!.ts &&
        event.ts + (event.dur ?? 0) > start.ts,
    ),
  );
  expect(synchronous.map((event) => event.name)).toEqual([]);
}

function expectCachedScroll(
  report: { frames: Array<{ cached: boolean; scrollTop: number }> },
  scrollTop: number,
) {
  const cached = report.frames.filter((frame) => frame.cached);
  expect(cached.length).toBeGreaterThan(0);
  expect(report.frames.at(-1)?.cached).toBe(false);
  for (const frame of cached) {
    expect(frame.scrollTop).toBe(scrollTop);
  }
  expect(report.frames.at(-1)?.scrollTop).toBe(scrollTop);
}

function expectCachedRows(
  report: {
    frames: Array<{
      cached: boolean;
      scrollTop: number;
      mountedRows: Array<{ key: string }>;
      rows: Array<{ key: string }>;
    }>;
  },
  scrollTop: number,
) {
  expectCachedScroll(report, scrollTop);
  const cached = report.frames.filter((frame) => frame.cached);
  const live = report.frames.at(-1)!;
  for (const frame of cached) {
    expect(frame.mountedRows.length).toBeGreaterThan(0);
    expect(frame.rows.length).toBeGreaterThan(0);
    expect(frame.mountedRows.map((row) => row.key)).toEqual(live.mountedRows.map((row) => row.key));
    expect(frame.rows.map((row) => row.key)).toEqual(live.rows.map((row) => row.key));
  }
}

suite.define(() => {
  it.each([false, true])(
    "restores cached sidebar rows while a peer resolves its profile (hasTouch=%s)",
    async (hasTouch) => {
      const fixture = createControlUiTeamScaleFixture({
        baseUrl: suite.server.baseUrl,
        sidebarCachedParity: true,
      });
      const archived = fixture.scenario.sessions![1]!;
      archived.archived = true;
      const lists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width: 1719, height: 1179 }, hasTouch },
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
          await context.addInitScript(() => {
            const geometry = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
            let measured = false;
            Object.defineProperty(Element.prototype, "scrollHeight", {
              ...geometry,
              get(this: Element) {
                const restoring =
                  !measured &&
                  this.isConnected &&
                  this.classList.contains("sidebar-shell__body") &&
                  this.closest("aside.sidebar")?.getAttribute("data-snapshot-state") === "cached";
                if (restoring) {
                  measured = true;
                  performance.mark("sidebar-restore-geometry-start");
                }
                return geometry.get!.call(this);
              },
            });
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
            Object.defineProperty(Element.prototype, "scrollTop", {
              ...descriptor,
              set(this: Element, value: number) {
                const restoring =
                  value === 1400 &&
                  this.isConnected &&
                  this.classList.contains("sidebar-shell__body") &&
                  this.closest("aside.sidebar")?.getAttribute("data-snapshot-state") === "cached";
                if (restoring) {
                  performance.mark("sidebar-restore-native-start");
                }
                descriptor.set!.call(this, value);
                if (restoring) {
                  performance.mark("sidebar-restore-native-end");
                  performance.mark("sidebar-restore-geometry-end");
                }
              },
            });
          });
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
          await page.locator(".sidebar-recent-session").nth(10).waitFor();
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(hasTouch);
          expect(
            await page
              .locator(".sidebar-shell__body")
              .evaluate((element) =>
                Number.parseFloat(
                  getComputedStyle(element).getPropertyValue("--sidebar-session-row-floor"),
                ),
              ),
          ).toBe(hasTouch ? 44 : 32);
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
          const saveScroll = (offset: number) =>
            page.evaluate(async (scrollTop) => {
              const scroller = document.querySelector<HTMLElement>(".sidebar-shell__body")!;
              const saved = new Promise<number>((resolve) => {
                // oxlint-disable-next-line typescript/unbound-method -- call preserves each native store receiver.
                const put = IDBObjectStore.prototype.put;
                IDBObjectStore.prototype.put = function (value, key) {
                  const request = put.call(this, value, key);
                  if (
                    this.name === "sidebarSnapshots" &&
                    value.model?.scrollTop === scrollTop &&
                    value.model.windowKeys.length > 0
                  ) {
                    IDBObjectStore.prototype.put = put;
                    this.transaction.addEventListener(
                      "complete",
                      () => resolve(value.model.scrollTop),
                      {
                        once: true,
                      },
                    );
                  }
                  return request;
                };
              });
              scroller.scrollTop = scrollTop;
              scroller.dispatchEvent(new Event("scroll"));
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              });
              window.dispatchEvent(new Event("pagehide"));
              return saved;
            }, offset);
          const devtools = await context.newCDPSession(page);
          let restoreTrace: RestoreTraceEvent[] = [];
          devtools.on("Tracing.dataCollected", ({ value }: { value: RestoreTraceEvent[] }) =>
            restoreTrace.push(...value),
          );
          try {
            for (const face of ["chat", "dashboard"] as const) {
              const artifact = `${hasTouch ? "coarse" : "fine"}-${face}`;
              await page.goto(
                controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, face),
              );
              await gateway.waitForRequest("connect");
              await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
              await page.evaluate(() => new Promise(requestAnimationFrame));
              await page
                .locator("aside.sidebar")
                .screenshot({ path: path.join(suite.artifactDir, `${artifact}-cached.png`) });
              await gateway.resolveDeferred("connect");
              await page
                .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
                .waitFor();
              await page.evaluate(() => new Promise(requestAnimationFrame));
              const report = await page.evaluate(() =>
                Reflect.get(window, "__sidebarPresentation").read(),
              );
              await writeFile(
                path.join(suite.artifactDir, `${artifact}-parity.json`),
                JSON.stringify(report, null, 2),
              );
              expectCachedRows(report, 0);
              await page
                .locator("aside.sidebar")
                .screenshot({ path: path.join(suite.artifactDir, `${artifact}-live.png`) });

              expect(await saveScroll(1400)).toBe(1400);
              restoreTrace = [];
              await devtools.send("Tracing.start", {
                categories: "devtools.timeline,blink.user_timing",
                transferMode: "ReportEvents",
              });
              try {
                await page.reload();
                await gateway.waitForRequest("connect");
                await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
                await page.evaluate(() => Reflect.get(window, "__sidebarPresentation").nextFrame());
                expect(
                  await page
                    .locator(".sidebar-shell__body")
                    .evaluate((element) => element.scrollTop),
                ).toBe(1400);
                expect(
                  await evaluateControlUiContext(page, (app) => app.gateway.snapshot.hello),
                ).toBeNull();
              } finally {
                const complete = new Promise<void>((resolve) => {
                  devtools.once("Tracing.tracingComplete", () => resolve());
                });
                await devtools.send("Tracing.end");
                await complete;
                await writeFile(
                  path.join(suite.artifactDir, `${artifact}-scroll-restore.trace.json`),
                  JSON.stringify({ traceEvents: restoreTrace }),
                );
              }
              expectRestoreWithoutSynchronousLayout(restoreTrace);
              await gateway.resolveDeferred("connect");
              await page
                .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
                .waitFor();
              await page.evaluate(() => new Promise(requestAnimationFrame));
              const scrollPresentation = await page.evaluate(() =>
                Reflect.get(window, "__sidebarPresentation").read(),
              );
              await writeFile(
                path.join(suite.artifactDir, `${artifact}-scroll-presentation.json`),
                JSON.stringify(scrollPresentation, null, 2),
              );
              expectCachedRows(scrollPresentation, 1400);
              if (hasTouch) {
                const end = await page
                  .locator(".sidebar-shell__body")
                  .evaluate((element) => element.scrollHeight - element.clientHeight);
                expect(end).toBeGreaterThan(1400);
                expect(await saveScroll(end)).toBe(end);
                await page.reload();
                await gateway.waitForRequest("connect");
                await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
                await page.evaluate(() => new Promise(requestAnimationFrame));
                const cachedEndTop = await page
                  .locator(".sidebar-shell__body")
                  .evaluate((element) => element.scrollTop);
                expect(
                  await evaluateControlUiContext(page, (app) => app.gateway.snapshot.hello),
                ).toBeNull();
                await gateway.resolveDeferred("connect");
                await page
                  .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
                  .waitFor();
                await page.evaluate(() => new Promise(requestAnimationFrame));
                const endPresentation = await page.evaluate(() =>
                  Reflect.get(window, "__sidebarPresentation").read(),
                );
                await writeFile(
                  path.join(suite.artifactDir, `${artifact}-end-presentation.json`),
                  JSON.stringify({ savedEnd: end, cachedEndTop, ...endPresentation }, null, 2),
                );
                expect(cachedEndTop).toBe(end);
                expectCachedScroll(endPresentation, end);
              }
              expect(await saveScroll(0)).toBe(0);
            }
          } finally {
            await devtools.detach();
          }
        },
      );
    },
  );

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
