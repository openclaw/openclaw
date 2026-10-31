import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { warmReloadProbe } from "../../../scripts/lib/control-ui-warm-reload-probe.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiE2eWaitTimeoutMs } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import { installTeamScaleSidebarPresentation } from "../test-helpers/control-ui-sidebar-presentation.test-support.ts";
import { revealSidebarTarget } from "../test-helpers/control-ui-sidebar-window.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Complete sidebar roster handoff" });

suite.define(() => {
  it.each([
    { face: "chat", changes: false, rootLast: false },
    { face: "chat", changes: true, rootLast: false },
    { face: "dashboard", changes: false, rootLast: true },
  ] as const)(
    "keeps cached $face rows until the roster settles (changes=$changes, rootLast=$rootLast)",
    async ({ face, changes, rootLast }) => {
      const fixture = createControlUiTeamScaleFixture({
        baseUrl: suite.server.baseUrl,
        sidebarPersistentChildren: true,
        sidebarPresentation: true,
      });
      const { parentKey, childKeys } = fixture.sidebarPersistentChildren!;
      const owner = fixture.sidebarListInput.rows[0]!.owner!;
      const ownerMatch = { ownerId: owner.actor.id };
      // Involving me excludes off-window child links. Keep an owned roster
      // larger than a boot page so its children still require a separate read.
      const ownedRoots = fixture.sidebarListInput.rows.slice(0, fixture.counts.firstPage + 1);
      const children = fixture.sidebarListInput.rows.filter((row) => childKeys.includes(row.key));
      for (const row of [...ownedRoots, ...children]) {
        row.owner = owner;
      }
      const lists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
        async ({ page }) => {
          await page.clock.install();
          await page.route("**/__openclaw__/**", async (route) => {
            const asset = fixture.assets.get(new URL(route.request().url()).pathname);
            if (asset) {
              await route.fulfill({ status: 200, ...asset });
            } else {
              await route.fallback();
            }
          });
          await page.addInitScript(
            ({ settingsKey, ownerKey, ownerId, entries }) => {
              localStorage.setItem(
                settingsKey,
                JSON.stringify({
                  sidebarAgentsMode: "chip",
                  railShortcuts: entries,
                  navigationByProfile: { "team-person-001": { railShortcuts: entries } },
                }),
              );
              localStorage.setItem(ownerKey, `owner:${ownerId}`);
            },
            {
              settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              ownerId: owner.actor.id,
              ownerKey: `openclaw.control.sidebarSessionOwnerFilter.v1:${controlUiBundledGatewayUrl(suite.server.baseUrl)}:team-person-001`,
              entries: fixture.sidebarEntries,
            },
          );
          const gateway = await installMockGateway(
            page,
            { ...fixture.scenario, heldMethods: ["connect"] },
            {
              requestHandlers: {
                "sessions.list": async (value) => {
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
          await page.addInitScript({
            content: `{ const __name = (fn) => fn; (${warmReloadProbe.toString()})(); }`,
          });
          await page.addInitScript({
            content: `(${installTeamScaleSidebarPresentation.toString()})(${JSON.stringify(fixture.sidebarPresentation)});`,
          });
          await page.goto(
            controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, face),
          );
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          const sidebar = page.locator("aside.sidebar");
          const viewport = sidebar.locator(".sidebar-shell__body");
          const geometry = () =>
            sidebar.evaluate((element) => {
              const scroller = element.querySelector<HTMLElement>(".sidebar-shell__body")!;
              return {
                scrollTop: scroller.scrollTop,
                height: scroller.clientHeight,
                scrollHeight: scroller.scrollHeight,
                top: scroller.getBoundingClientRect().top,
                rows: [...element.querySelectorAll<HTMLElement>(".sidebar-recent-session")].map(
                  (row) => ({
                    key: row.getAttribute("data-session-key"),
                    top: row.getBoundingClientRect().top,
                    height: row.getBoundingClientRect().height,
                  }),
                ),
              };
            });
          const capture = async (stage: string) => {
            const frame = await takeControlUiScreenshotFrame(page, sidebar, [sidebar], {
              animations: "disabled",
              elements: [sidebar],
            });
            await writeFile(path.join(suite.artifactDir, `${face}-${stage}.png`), frame.png);
          };
          const saved = () =>
            page.locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]');
          await saved().waitFor();
          const toggle = sidebar.locator(`[data-child-session-toggle="${parentKey}"]`);
          await revealSidebarTarget(viewport, toggle);
          if ((await toggle.getAttribute("aria-expanded")) !== "true") {
            await toggle.click();
          }
          await sidebar.locator(`[data-session-key="${childKeys[0]}"]`).waitFor();
          const expansion = await page.evaluateHandle(() => {
            // oxlint-disable-next-line typescript/unbound-method -- preserve the IDB store receiver below.
            const put = IDBObjectStore.prototype.put;
            return {
              done: new Promise<void>((resolve) => {
                IDBObjectStore.prototype.put = function (this: IDBObjectStore, value, key) {
                  const request = put.call(this, value, key);
                  if (
                    this.name === "sidebarSnapshots" &&
                    value.model?.sections?.some(
                      (section: { visibleLimit: number }) => section.visibleLimit > 10,
                    )
                  ) {
                    IDBObjectStore.prototype.put = put;
                    this.transaction.addEventListener("complete", () => resolve(), { once: true });
                  }
                  return request;
                };
              }),
            };
          });
          await sidebar
            .locator(".sidebar-session-content .sidebar-session-pagination__button")
            .filter({ hasText: "Show more" })
            .first()
            .click();
          await expansion.evaluate((observation) => observation.done);
          await expansion.dispose();
          await saved().waitFor();
          await viewport.evaluate((element) => {
            element.scrollTop = 0;
          });
          // The selected pin is retained offscreen; wait for an unretained top
          // row to prove the scroll event has published the new visible window.
          await sidebar.locator(`[data-session-key="${fixture.pinnedKeys[1]}"]`).waitFor();
          await sidebar.locator(".session-row-badge--pull-request").nth(6).waitFor();
          const beforeReload = await geometry();
          const indicators = () =>
            sidebar.locator(".sidebar-recent-session").evaluateAll((rows) =>
              rows.map((row) => ({
                key: row.getAttribute("data-session-key"),
                unread: row.querySelectorAll(".session-unread-dot,.session-glyph__badge--unread")
                  .length,
                badges: [...row.querySelectorAll(".session-row-badge")].map((badge) => ({
                  class: badge.className,
                  state: badge.getAttribute("data-pull-request-state"),
                })),
              })),
            );
          const beforeIndicators = await indicators();
          expect(beforeIndicators.some((row) => row.unread > 0)).toBe(true);
          await writeFile(
            path.join(suite.artifactDir, `${face}-before-reload-geometry.json`),
            JSON.stringify(beforeReload, null, 2),
          );

          await page.reload();
          await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
          await capture("cached");
          const cachedGeometry = await geometry();
          // Connection status owns a footer while the Gateway reconnects. Keep
          // exact content and geometry proof over the viewport both states share.
          const commonTop = Math.max(beforeReload.top, cachedGeometry.top);
          const commonBottom = Math.min(
            beforeReload.top + beforeReload.height,
            cachedGeometry.top + cachedGeometry.height,
          );
          const visibleGeometry = (layout: typeof beforeReload) =>
            layout.rows.filter((row) => row.top + row.height > commonTop && row.top < commonBottom);
          const expectedGeometry = visibleGeometry(beforeReload);
          const expected = expectedGeometry.map((row) => row.key);
          expect((await indicators()).filter((row) => expected.includes(row.key))).toEqual(
            beforeIndicators.filter((row) => expected.includes(row.key)),
          );
          expect(expected.length).toBeGreaterThan(10);
          expect(visibleGeometry(cachedGeometry)).toEqual(expectedGeometry);
          const rowKeys = () =>
            sidebar.locator(".sidebar-session-content .sidebar-recent-session").evaluateAll(
              (rows, bounds) =>
                rows
                  .filter((row) => {
                    const rect = row.getBoundingClientRect();
                    return rect.bottom > bounds.top && rect.top < bounds.bottom;
                  })
                  .map((row) => row.getAttribute("data-session-key")),
              { top: commonTop, bottom: commonBottom },
            );
          const childMatch = { spawnedBy: parentKey };
          await gateway.deferNext("sessions.list", childMatch);
          await gateway.deferNext("sessions.list", ownerMatch);
          if (rootLast) {
            await gateway.deferNext("sessions.list", { ownerFirst: true });
          }
          await gateway.waitForRequest("connect");
          await pauseVirtualClock(page);
          const connectedAt = await page.evaluate(() => performance.now());
          await gateway.resolveDeferred("connect");
          await page.clock.runFor(100);
          const canonical = await gateway.waitForRequest("sessions.list", {
            match: { ownerFirst: true },
          });
          const owned = await gateway.waitForRequest("sessions.list", {
            match: ownerMatch,
          });
          expect(await sidebar.getAttribute("data-snapshot-state")).toBe("cached");
          await writeFile(
            path.join(suite.artifactDir, `${face}-cached-geometry.json`),
            JSON.stringify(await geometry(), null, 2),
          );
          expect(await rowKeys()).toEqual(expected);
          await gateway.resolveDeferred(
            "sessions.list",
            lists.list(asRecord(owned.params)!).result,
            {
              match: ownerMatch,
            },
          );
          await expect
            .poll(
              async () => {
                // Reply delivery can outlive a clock jump. Drain the frame that discovers children.
                await page.clock.runFor(20);
                return (await gateway.getRequests("sessions.list", childMatch)).length;
              },
              { timeout: controlUiE2eWaitTimeoutMs },
            )
            .toBeGreaterThan(0);
          const childRequest = await gateway.waitForRequest("sessions.list", { match: childMatch });
          const childResult = lists.list(asRecord(childRequest.params)!).result;
          await page.clock.runFor(3200);
          await capture("awaiting-live");
          expect(await sidebar.getAttribute("data-snapshot-state")).toBe("cached");
          let childReleased = false;
          const releaseChildren = async () => {
            if (!childReleased) {
              childReleased = true;
              await gateway.resolveDeferred("sessions.list", childResult, { match: childMatch });
            }
          };
          const cachedVisibleRows = await sidebar.evaluateHandle((element, keys) => {
            const rows = [
              ...element.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
            ].filter((row) => keys.includes(row.getAttribute("data-session-key")));
            const host = element.closest("openclaw-app-sidebar")!;
            const parent = host.parentNode!;
            const next = host.nextSibling;
            // Native layout moves preserve the same host and its cached children.
            host.remove();
            parent.insertBefore(host, next);
            return rows;
          }, expected);
          try {
            expect(await sidebar.getAttribute("data-snapshot-state")).toBe("cached");
            expect(await rowKeys()).toEqual(expected);
            expect(
              await cachedVisibleRows.evaluate((rows) => rows.every((row) => row.isConnected)),
            ).toBe(true);
            if (rootLast) {
              await releaseChildren();
            }
            await page.clock.runFor(1000);
            // Either roster can remain pending after the foreground is ready.
            const beforeChildren = {
              state: await sidebar.getAttribute("data-snapshot-state"),
              rows: await rowKeys(),
              ...(await evaluateControlUiContext(
                page,
                (context, startedAt) => ({
                  elapsedMs: performance.now() - startedAt,
                  foregroundReady: context.connectionBootstrap.foregroundReady,
                }),
                connectedAt,
              )),
            };
            expect(
              await gateway.getRequests("sessions.list", { ownerFirst: true }),
            ).not.toHaveLength(0);

            const readinessDiagnostic = JSON.stringify(beforeChildren);
            expect(beforeChildren.elapsedMs, readinessDiagnostic).toBeGreaterThan(3000);
            expect(beforeChildren.foregroundReady, readinessDiagnostic).toBe(true);
            expect(beforeChildren.state, readinessDiagnostic).toBe("cached");
            expect(beforeChildren.rows).toEqual(expected);
            if (changes) {
              await releaseChildren();
              await page.clock.resume();
              await saved().waitFor();
              await revealSidebarTarget(viewport, toggle);
              const now = fixture.sidebarListInput.now + 1000;
              const renamed = {
                ...fixture.sidebarListInput.rows[1]!,
                label: "Renamed during reload",
                displayName: "Renamed during reload",
                updatedAt: now,
                snapshotAt: now,
              };
              const stopped = {
                ...fixture.sidebarListInput.rows[2]!,
                hasActiveRun: false,
                activeRunIds: [],
                status: "done",
                updatedAt: now,
                snapshotAt: now,
              } satisfies GatewaySessionRow;
              const deleted = fixture.sidebarListInput.rows[3]!;
              const created = {
                ...fixture.sidebarListInput.rows[4]!,
                key: "agent:main:chat:00000000-0000-4000-8000-000000009999",
                sessionId: "created-during-reload",
                label: "Created during reload",
                displayName: "Created during reload",
                owner: fixture.sidebarListInput.rows[0]!.owner,
                participants: [],
                hasActiveRun: false,
                activeRunIds: [],
                status: "done",
                updatedAt: now,
                snapshotAt: now,
              } satisfies GatewaySessionRow;
              const renamedRow = sidebar.locator(`[data-session-key="${renamed.key}"]`);
              await revealSidebarTarget(viewport, renamedRow);
              const retainedRow = await renamedRow.elementHandle();
              expect(retainedRow).not.toBeNull();
              const stoppedRow = sidebar.locator(`[data-session-key="${stopped.key}"]`);
              expect(await stoppedRow.getAttribute("class")).toContain("session-row-host--running");
              const refreshBefore = (await gateway.getRequests("sessions.list", ownerMatch)).length;
              lists.apply({ upsert: [renamed, stopped, created], removeKeys: [deleted.key] });
              for (const [row, reason] of [
                [renamed, "patch"],
                [stopped, "agent.run.finished"],
                [created, "create"],
                [deleted, "delete"],
              ] as const) {
                await gateway.emitGatewayEvent("sessions.changed", {
                  sessionKey: row.key,
                  sessionId: row.sessionId,
                  agentId: "main",
                  reason,
                  ts: now,
                  ...(reason === "delete" ? {} : { session: row, ancestorSessions: [] }),
                });
              }
              // Advance the list owner's five-second invalidation collection window.
              await pauseVirtualClock(page);
              await page.clock.runFor(5001);
              await page.clock.resume();
              await gateway.waitForRequest("sessions.list", {
                match: ownerMatch,
                after: refreshBefore,
              });
              await renamedRow.getByText(renamed.label, { exact: true }).waitFor();
              await sidebar.getByText(created.label, { exact: true }).waitFor();
              await sidebar
                .locator(`[data-session-key="${deleted.key}"]`)
                .waitFor({ state: "detached" });
              await sidebar
                .locator(`[data-session-key="${stopped.key}"].session-row-host--running`)
                .waitFor({ state: "detached" });
              expect(await retainedRow!.evaluate((element) => element.isConnected)).toBe(true);
              await retainedRow!.dispose();
              const otherOwnerRow = fixture.sidebarListInput.rows.find(
                (row) =>
                  row.owner?.actor.id !== owner.actor.id &&
                  !row.snoozedUntil &&
                  !row.pinned &&
                  !row.spawnedBy,
              )!;
              const otherOwnerId = otherOwnerRow.owner?.actor.id;
              assert.ok(otherOwnerId, "The other fixture session must have an owner id");
              await chooseSidebarOwner(page, `owner:${otherOwnerId}`);
              await gateway.waitForRequest("sessions.list", { match: { ownerId: otherOwnerId } });
              await sidebar
                .locator(`[data-session-key="${parentKey}"]`)
                .waitFor({ state: "detached" });
              await sidebar
                .getByText(created.label, { exact: true })
                .waitFor({ state: "detached" });
              await revealSidebarTarget(
                viewport,
                sidebar.locator(`[data-session-key="${otherOwnerRow.key}"]`),
              );
            }

            await releaseChildren();
            if (rootLast) {
              await gateway.resolveDeferred(
                "sessions.list",
                lists.list(asRecord(canonical.params)!).result,
                { match: { ownerFirst: true } },
              );
            }
            await page.clock.resume();
            await saved().waitFor();
            await page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
            );
            await capture("complete");
            const finalRows = await rowKeys();
            const proof = await page.evaluate(() => Reflect.get(window, "__warmReload").read());
            const first = proof.sidebarFrames.findIndex(
              (frame: { cached: boolean; rowIds: string[] }) => frame.cached && frame.rowIds.length,
            );
            const frames: Array<{ cached: boolean; rowIds: string[]; retained: number }> =
              proof.sidebarFrames.slice(first);
            await writeFile(
              path.join(suite.artifactDir, `${face}-complete-roster.json`),
              JSON.stringify(
                {
                  ...proof,
                  childRequest,
                  beforeChildren,
                  expected,
                  finalRows,
                },
                null,
                2,
              ),
            );
            if (changes) {
              expect(finalRows).not.toContain(parentKey);
              for (const key of childKeys) {
                expect(finalRows).not.toContain(key);
              }
            } else {
              expect(finalRows).toEqual(expected);
              expect(visibleGeometry(await geometry())).toEqual(expectedGeometry);
            }
            expect(first).toBeGreaterThanOrEqual(0);
            if (!changes) {
              expect(
                frames.every((frame) => {
                  const visible = frame.rowIds.filter((key) => expected.includes(key));
                  return (
                    visible.length === expected.length &&
                    visible.every((key, index) => key === expected[index])
                  );
                }),
              ).toBe(true);
              expect(frames.at(-1)?.retained).toBeGreaterThanOrEqual(expected.length);
              expect(
                await cachedVisibleRows.evaluate((rows) => rows.every((row) => row.isConnected)),
              ).toBe(true);
            }
            expect(
              frames.filter(
                (frame, index) => index > 0 && frame.cached !== frames[index - 1]!.cached,
              ),
            ).toHaveLength(1);
            if (!changes) {
              await revealSidebarTarget(viewport, toggle);
              expect(await toggle.getAttribute("aria-expanded")).toBe("true");
              await sidebar.locator(`[data-session-key="${childKeys[0]}"]`).waitFor();
            }
          } finally {
            await cachedVisibleRows.dispose();
            await releaseChildren();
          }
        },
      );
    },
  );
});
