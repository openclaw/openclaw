import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each(["fresh", "stale"] as const)(
    "keeps expanded child rows still through cached replay (initial primary: %s)",
    async (initialPrimary) => {
      const baseTime = Date.parse("2026-09-16T00:00:00Z");
      const parentKey = "agent:main:jitter-parent";
      const selectedKey = "agent:main:jitter-selected";
      const children = Array.from({ length: 12 }, (_, index) =>
        sessionRow(`agent:main:subagent:jitter-${index}`, `Research task ${index + 1}`, baseTime, {
          spawnedBy: parentKey,
          snapshotAt: baseTime + 200,
          createdAt: baseTime - index,
          hasActiveRun: index >= 4 && index <= 8,
          activeRunIds: index >= 4 && index <= 8 ? [`run-${index}`] : [],
          status: index >= 4 && index <= 8 ? "running" : "done",
        }),
      );
      const parent = sessionRow(parentKey, "Research home", baseTime + 10, {
        childSessions: children.map((child) => child.key),
        category: "Development",
        snapshotAt: baseTime + 200,
      });
      const selected = sessionRow(selectedKey, "Section below children", baseTime, {
        category: "PR: Open",
        snapshotAt: baseTime + 200,
      });
      const oldChildren = children.map((child, index) =>
        index === 8 ? { ...child, hasActiveRun: false, activeRunIds: [], status: "done" } : child,
      );
      const cachedRoot = {
        ...sessionsListResponse(
          [parent, selected, ...oldChildren].map((row) =>
            Object.assign({}, row, { snapshotAt: baseTime + 150 }),
          ),
        ),
        ts: baseTime + 150,
      };
      const initialRoot = {
        ...sessionsListResponse(
          [parent, selected, ...(initialPrimary === "stale" ? oldChildren : children)].map((row) =>
            Object.assign({}, row, { snapshotAt: baseTime + 100 }),
          ),
        ),
        ts: baseTime + 100,
      };
      const freshChildren = { ...sessionsListResponse(children), ts: baseTime + 200 };
      const childMatch = { spawnedBy: parentKey };
      const responses = (root: typeof cachedRoot) => ({
        cases: [
          { match: childMatch, response: freshChildren },
          {
            match: { spawnedBy: selectedKey },
            response: { ...sessionsListResponse([]), ts: baseTime + 200 },
          },
          { response: root },
        ],
      });
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 1000 },
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 1000 } },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessions: [parent, selected, ...children],
        sessionKey: selectedKey,
        sessionGroups: ["Development", "PR: Open"],
        methodResponses: {
          "sessions.list": responses(initialRoot),
        },
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
        const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
        await expect.poll(() => toggle.count()).toBe(1);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        await page.mouse.move(1100, 100);
        const childList = page.locator(
          `[data-session-tree="${parentKey}"] > .sidebar-session-tree__children > .sidebar-session-tree__list`,
        );
        const keys = () =>
          childList
            .locator(":scope > [data-session-tree]")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-tree")));
        // Wait for the actual newer child read, not merely the initial root rendering.
        await expect
          .poll(() =>
            page.evaluate((key) => {
              const sidebar =
                document.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
              return sidebar?.sessionData.childSessionRowsByParent[key]?.length;
            }, parentKey),
          )
          .toBe(12);
        // Initial roots may be stale too: publication of the newer child page
        // must itself surface the ninth running child, before any root replay.
        await expect
          .poll(() =>
            page.evaluate((key) => {
              const sidebar =
                document.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
              return sidebar?.sessionData.context?.sessions.listSnapshot({
                spawnedBy: key,
                limit: 100,
                includeGlobal: false,
                includeUnknown: false,
                configuredAgentsOnly: true,
              }).result?.ts;
            }, parentKey),
          )
          .toBe(freshChildren.ts);
        // This proof annotation stays outside the sidebar and reports real DOM geometry.
        await page.evaluate(
          (proof) => {
            const note = document.createElement("aside");
            note.id = "sidebar-replay-proof";
            note.dataset.stage = "Newer child page published; before cached root replay";
            note.style.cssText =
              "position:fixed;left:450px;top:80px;z-index:10000;background:#18212b;color:white;padding:20px;font:18px/1.6 monospace;white-space:pre;pointer-events:none";
            document.body.append(note);
            const update = () => {
              const list = document.querySelector(
                `[data-session-tree="${proof.parentKey}"] > .sidebar-session-tree__children > .sidebar-session-tree__list`,
              );
              const lower = document.querySelector(`[data-session-key="${proof.selectedKey}"]`);
              const count = list?.querySelectorAll(":scope > [data-session-tree]").length ?? 0;
              note.textContent = `SYNTHETIC GATEWAY PROOF — initial ${proof.initialPrimary}\n${note.dataset.stage}\nVisible children: ${count} / expected 9\nLower row Y: ${lower?.getBoundingClientRect().y.toFixed(3)} px`;
              requestAnimationFrame(update);
            };
            update();
          },
          { parentKey, selectedKey, initialPrimary },
        );
        let initialPublicationError: Error | undefined;
        try {
          await expect
            .poll(() => childList.locator(":scope > [data-session-tree]").count())
            .toBe(9);
        } catch (error) {
          // Retain this assertion failure while completing the replay diagnostics.
          initialPublicationError = error instanceof Error ? error : new Error(String(error));
        } finally {
          const initialRows = await page.evaluate((key) => {
            const sidebar =
              document.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
            const data = sidebar?.sessionData;
            const root = data?.context?.sessions.state.result;
            const target = "agent:main:subagent:jitter-8";
            return {
              rootTs: root?.ts,
              rootRow: root?.sessions.find((row) => row.key === target),
              hydratedRow: data?.childSessionRowsByParent[key]?.find((row) => row.key === target),
            };
          }, parentKey);
          await writeFile(
            path.join(suite.artifactDir, `${initialPrimary}-initial-publication.json`),
            JSON.stringify({ ...initialRows, visibleKeys: await keys() }, null, 2),
          );
          await page.screenshot({
            path: path.join(suite.artifactDir, `${initialPrimary}-after-child-publication.png`),
          });
        }
        // Owner publication was asserted above; the dwell makes the recording readable.
        await page.waitForTimeout(2000);
        const initialKeys = await keys();
        const lower = page.locator(`[data-session-key="${selectedKey}"]`);
        const initialBounds = await lower.boundingBox();
        await page.screenshot({
          path: path.join(suite.artifactDir, `${initialPrimary}-fresh-child-list.png`),
        });
        const rootMatch = { agentId: "main" };
        const rootRequests = (await gateway.getRequests("sessions.list", rootMatch)).length;
        await gateway.setMethodResponse("sessions.list", responses(cachedRoot));
        // Observe committed DOM changes and frames, including any transient shrink
        // that a second child read could repair before the final assertion.
        const rowObservation = await page.evaluateHandle((key) => {
          const sidebar = document.querySelector("openclaw-app-sidebar");
          if (!sidebar) {
            throw new Error("Expected mounted sidebar");
          }
          const counts: number[] = [];
          let sampleCount = 0;
          const sample = () => {
            const list = sidebar.querySelector(
              `[data-session-tree="${key}"] > .sidebar-session-tree__children > .sidebar-session-tree__list`,
            );
            const count = list?.querySelectorAll(":scope > [data-session-tree]").length ?? 0;
            sampleCount += 1;
            if (counts.at(-1) !== count) {
              counts.push(count);
            }
          };
          const observer = new MutationObserver(sample);
          observer.observe(sidebar, { childList: true, subtree: true });
          let frameId = 0;
          const frame = () => {
            sample();
            frameId = requestAnimationFrame(frame);
          };
          sample();
          frameId = requestAnimationFrame(frame);
          return {
            stop() {
              observer.disconnect();
              cancelAnimationFrame(frameId);
              sample();
              return { counts, sampleCount };
            },
          };
        }, parentKey);
        await page.evaluate(() => {
          const note = document.getElementById("sidebar-replay-proof");
          if (note) {
            note.dataset.stage = "Requesting cached root replay (snapshot 150 < child 200)";
          }
        });
        // This unrelated row invalidates the root query, not the observed child query.
        await gateway.emitGatewayEvent("sessions.changed", {
          key: selectedKey,
          sessionKey: selectedKey,
          agentId: "main",
          reason: "run",
          updatedAt: baseTime + 300,
        });
        await gateway.waitForRequest("sessions.list", { after: rootRequests, match: rootMatch });
        // A sent request does not prove publication. Wait for the canonical owner
        // to admit the exact cached page before awaiting the resulting paint.
        await expect
          .poll(() =>
            page.evaluate(() => {
              const sidebar =
                document.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
              return sidebar?.sessionData.context?.sessions.state.result?.ts;
            }),
          )
          .toBe(cachedRoot.ts);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
              });
            }),
        );
        await page.evaluate(() => {
          const note = document.getElementById("sidebar-replay-proof");
          if (note) {
            note.dataset.stage = "Cached root 150 published — inspect count and lower row";
          }
        });
        await page.waitForTimeout(2500);
        await page.screenshot({
          path: path.join(suite.artifactDir, `${initialPrimary}-after-cached-root-refresh.png`),
        });
        const finalKeys = await keys();
        const finalBounds = await lower.boundingBox();
        const observed = await rowObservation.evaluate((observation) => observation.stop());
        await rowObservation.dispose();
        await writeFile(
          path.join(suite.artifactDir, `${initialPrimary}-cached-list-proof.json`),
          JSON.stringify(
            {
              initialPrimary,
              initialPublicationPassed: initialPublicationError === undefined,
              initialPublicationError:
                initialPublicationError instanceof Error
                  ? initialPublicationError.message
                  : undefined,
              initialKeys,
              finalKeys,
              initialY: initialBounds?.y,
              finalY: finalBounds?.y,
              publishedTs: cachedRoot.ts,
              observed,
            },
            null,
            2,
          ),
        );
        if (initialPublicationError !== undefined) {
          throw initialPublicationError;
        }
        expect(observed.counts).toEqual([9]);
        expect(finalKeys).toEqual(initialKeys);
        expect(finalBounds?.y).toBe(initialBounds?.y);
        expect(
          await page.locator(`[data-show-more-children="${parentKey}"]`).textContent(),
        ).toContain("3");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
