import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["fresh", "stale"] as const)(
    "keeps expanded spawned-session rows still through cached replay (initial primary: %s)",
    async (initialPrimary) => {
      const baseTime = Date.parse("2026-09-16T00:00:00Z");
      const parentKey = "agent:main:jitter-parent";
      const selectedKey = "agent:main:jitter-selected";
      const children = Array.from({ length: 12 }, (_, index) =>
        sessionRow(
          `agent:main:dashboard:jitter-${index}`,
          `Research session ${index + 1}`,
          baseTime,
          {
            spawnedBy: parentKey,
            snapshotAt: baseTime + 200,
            createdAt: baseTime - index,
            hasActiveRun: index >= 4 && index <= 8,
            activeRunIds: index >= 4 && index <= 8 ? [`run-${index}`] : [],
            status: index >= 4 && index <= 8 ? "running" : "done",
          },
        ),
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
      const rootSnapshot = (rows: typeof children, offset: number) => ({
        ...sessionsListResponse(
          [parent, selected, ...rows].map((row) =>
            Object.assign({}, row, { snapshotAt: baseTime + offset }),
          ),
        ),
        ts: baseTime + offset,
      });
      const cachedRoot = rootSnapshot(oldChildren, 150);
      const initialRoot = rootSnapshot(initialPrimary === "stale" ? oldChildren : children, 100);
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
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 1000 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessions: [parent, selected, ...children],
            sessionKey: selectedKey,
            sessionGroups: ["Development", "PR: Open"],
            methodResponses: {
              "sessions.list": responses(initialRoot),
            },
          });
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
          // Wait for the owner to publish the complete newer child page before checking its paint.
          await expect
            .poll(() =>
              evaluateControlUiContext(
                page,
                ({ sessions }, key) => {
                  const result = sessions.listSnapshot({
                    spawnedBy: key,
                    limit: 100,
                    includeGlobal: false,
                    includeUnknown: false,
                    configuredAgentsOnly: true,
                  }).result;
                  return { count: result?.sessions.length, ts: result?.ts };
                },
                parentKey,
              ),
            )
            .toEqual({ count: 12, ts: freshChildren.ts });
          await expect
            .poll(() => childList.locator(":scope > [data-session-tree]").count())
            .toBe(9);
          // Wait for fonts before measuring row displacement.
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          const initialKeys = await keys();
          const lower = page.locator(`[data-session-key="${selectedKey}"]`);
          const initialBounds = await lower.boundingBox();
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
            const sample = () => {
              const list = sidebar.querySelector(
                `[data-session-tree="${key}"] > .sidebar-session-tree__children > .sidebar-session-tree__list`,
              );
              const count = list?.querySelectorAll(":scope > [data-session-tree]").length ?? 0;
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
                return counts;
              },
            };
          }, parentKey);
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
            .poll(() => evaluateControlUiContext(page, ({ sessions }) => sessions.state.result?.ts))
            .toBe(cachedRoot.ts);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => resolve());
                });
              }),
          );
          const finalKeys = await keys();
          const finalBounds = await lower.boundingBox();
          const observed = await rowObservation.evaluate((observation) => observation.stop());
          await rowObservation.dispose();
          expect(observed).toEqual([9]);
          expect(finalKeys).toEqual(initialKeys);
          expect(finalBounds?.y).toBe(initialBounds?.y);
          expect(
            await page.locator(`[data-show-more-children="${parentKey}"]`).textContent(),
          ).toContain("3");
        },
      );
    },
  );
});
