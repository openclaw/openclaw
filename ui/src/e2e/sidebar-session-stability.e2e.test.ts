import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("refreshes the selected child after a later child-list result", async () => {
    const baseTime = Date.parse("2026-09-07T12:00:00.000Z");
    const parentKey = "agent:main:research-parent";
    const childKey = "agent:main:research-child";
    const siblingKey = "agent:main:research-sibling";
    const parentRow = sessionRow(parentKey, "Research handoff", baseTime, {
      sessionId: "research-parent-session",
      childSessions: [childKey, siblingKey],
    });
    const childRow = sessionRow(childKey, "Research in progress", baseTime + 1, {
      sessionId: "research-child-session",
      spawnedBy: parentKey,
    });
    const siblingRow = sessionRow(siblingKey, "Supporting research", baseTime + 1, {
      sessionId: "research-sibling-session",
      spawnedBy: parentKey,
    });
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: [parentRow, childRow, siblingRow],
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { spawnedBy: parentKey },
              response: sessionsListResponse([childRow, siblingRow]),
            },
            { response: sessionsListResponse([parentRow]) },
          ],
        },
      },
      sessionKey: childKey,
    });
    try {
      const documentResponse = await page.goto(controlUiSessionUrl(suite.server.baseUrl, childKey));
      expect(documentResponse?.status()).toBe(200);
      const child = page.locator(`[data-session-key="${childKey}"]`);
      const sibling = page.locator(`[data-session-key="${siblingKey}"]`);
      await expect.poll(() => child.textContent()).toContain("Research in progress");
      await expect.poll(() => sibling.textContent()).toContain("Supporting research");
      expect(await child.getAttribute("class")).toContain("sidebar-recent-session--active");
      const childMatch = { spawnedBy: parentKey };
      const childRequests = (await gateway.getRequests("sessions.list", childMatch)).length;
      expect(childRequests).toBeGreaterThan(0);
      await gateway.deferNext("sessions.list", childMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        key: parentKey,
        sessionKey: parentKey,
        reason: "run",
        updatedAt: baseTime + 2,
      });
      await gateway.waitForRequest("sessions.list", { after: childRequests, match: childMatch });
      await gateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([
          {
            ...childRow,
            label: "Research completed",
            displayName: "Research completed",
            updatedAt: baseTime + 3,
          },
          {
            ...siblingRow,
            label: "Supporting research refreshed",
            displayName: "Supporting research refreshed",
            updatedAt: baseTime + 3,
          },
        ]),
      );
      // The sibling proves the new child snapshot rendered before checking the selected row.
      await expect.poll(() => sibling.textContent()).toContain("Supporting research refreshed");
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "selected-child-refreshed.png"),
        });
        await writeFile(
          path.join(suite.artifactDir, "selected-child-requests.json"),
          JSON.stringify(
            {
              requests: await gateway.getRequests("sessions.list"),
              selectedText: await child.textContent(),
              siblingText: await sibling.textContent(),
              documentSha256: createHash("sha256")
                .update(await documentResponse!.body())
                .digest("hex"),
              assets: await page.evaluate(() =>
                performance
                  .getEntriesByType("resource")
                  .map((entry) => entry.name)
                  .filter((name) => name.includes("/assets/")),
              ),
            },
            null,
            2,
          ),
        );
      }
      expect(await child.textContent()).toContain("Research completed");
      expect(await child.textContent()).not.toContain("Research in progress");
      expect(await child.count()).toBe(1);
      expect(await child.getAttribute("class")).toContain("sidebar-recent-session--active");
    } finally {
      await context.close();
    }
  });

  it.each([
    { colorScheme: "dark", pointer: "fine", textScale: 100, width: 1440 },
    { colorScheme: "light", pointer: "fine", textScale: 100, width: 1440 },
    { colorScheme: "dark", pointer: "fine", textScale: 100, width: 390 },
    { colorScheme: "light", pointer: "fine", textScale: 100, width: 390 },
    { colorScheme: "dark", pointer: "coarse", textScale: 100, width: 390 },
    { colorScheme: "light", pointer: "coarse", textScale: 100, width: 390 },
    { colorScheme: "dark", pointer: "fine", textScale: 140, width: 1440 },
  ] as const)(
    "keeps $colorScheme child rows stable through loading and refresh at $width px with a $pointer pointer and $textScale% text",
    async ({ colorScheme, pointer, textScale, width }) => {
      const baseTime = Date.parse("2026-09-04T12:00:00.000Z");
      const activeKey = "agent:main:loading-active";
      const parentKey = "agent:main:loading-parent";
      const childKey = "agent:main:loading-child";
      const parentRow = sessionRow(parentKey, "Research handoff", baseTime, {
        childSessions: [childKey],
      });
      const childRow = sessionRow(childKey, "Background research", baseTime - 1, {
        spawnedBy: parentKey,
      });
      const context = await suite.browser.newContext({
        colorScheme,
        hasTouch: pointer === "coarse",
        isMobile: pointer === "coarse",
        locale: "en-US",
        reducedMotion: width === 390 ? "reduce" : "no-preference",
        serviceWorkers: "block",
        viewport: { height: 900, width },
      });
      const page = await context.newPage();
      if (textScale !== 100) {
        await page.addInitScript(
          ({ scale, settingsKey }) => {
            localStorage.setItem(settingsKey, JSON.stringify({ textScale: scale }));
          },
          {
            scale: textScale,
            settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          },
        );
      }
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { spawnedBy: parentKey },
                response: sessionsListResponse([childRow]),
              },
              {
                response: sessionsListResponse([
                  sessionRow(activeKey, "Active session", baseTime + 1),
                  parentRow,
                ]),
              },
            ],
          },
        },
        sessionKey: activeKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(
          pointer === "coarse",
        );
        if (width === 390) {
          const drawerToggle = page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first();
          await drawerToggle.waitFor({ state: "visible" });
          await drawerToggle.click();
        }
        const childToggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
        await childToggle.waitFor({ state: "visible" });
        await gateway.deferNext("sessions.list", { spawnedBy: parentKey });
        await childToggle.click();
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parentKey } });

        const children = page.locator(
          `[data-session-tree="${parentKey}"] > .sidebar-session-tree__children`,
        );
        const loading = children.locator(":scope > .sidebar-session-tree__loading");
        await expect.poll(() => loading.count()).toBe(1);
        await captureUiProof(
          suite,
          page,
          `sidebar-child-loading-${colorScheme}-${width}-${pointer}.png`,
        );
        expect(await children.locator(":scope > .skeleton").count()).toBe(1);
        expect(await loading.getAttribute("aria-busy")).toBe("true");
        expect(await loading.getAttribute("aria-label")).toBe("Loading…");
        expect(
          await loading
            .locator("a, button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
            .count(),
        ).toBe(0);
        const loadingGeometry = await children.evaluate((element) => {
          const rowBounds = element.getBoundingClientRect();
          const barBounds = element
            .querySelector(".sidebar-session-tree__loading")!
            .getBoundingClientRect();
          return { left: barBounds.left, rowHeight: rowBounds.height };
        });
        if (textScale === 100) {
          expect(loadingGeometry.rowHeight).toBe(pointer === "coarse" ? 44 : 30);
        } else {
          expect(loadingGeometry.rowHeight).toBeGreaterThan(30);
        }

        await gateway.resolveDeferred("sessions.list");
        await expect.poll(() => loading.count()).toBe(0);
        const child = page.locator(`[data-session-key="${childKey}"]`);
        await child.waitFor({ state: "visible" });
        const childGeometry = await child.evaluate((element) => {
          const titleBounds = element
            .querySelector(".sidebar-recent-session__name")!
            .getBoundingClientRect();
          const rowBounds = element.parentElement!.parentElement!.getBoundingClientRect();
          return { left: titleBounds.left, rowHeight: rowBounds.height };
        });
        expect(childGeometry.left).toBe(loadingGeometry.left);
        // Chromium can quantize empty and text line boxes 1/64 CSS px apart.
        expect(childGeometry.rowHeight).toBeCloseTo(loadingGeometry.rowHeight, 1);

        const childMatch = { spawnedBy: parentKey };
        const childRequests = (await gateway.getRequests("sessions.list", childMatch)).length;
        await gateway.deferNext("sessions.list", childMatch);
        await gateway.emitGatewayEvent("sessions.changed", {
          key: activeKey,
          sessionKey: activeKey,
          reason: "run",
          updatedAt: baseTime + 2,
        });
        await gateway.waitForRequest("sessions.list", {
          after: childRequests,
          match: childMatch,
        });
        expect(await page.locator(".sidebar-session-tree__loading").count()).toBe(0);
        expect(await child.isVisible()).toBe(true);

        await gateway.resolveDeferred(
          "sessions.list",
          sessionsListResponse([
            { ...childRow, label: "Updated research", updatedAt: baseTime + 3 },
          ]),
        );
        await expect.poll(() => child.textContent()).toContain("Updated research");
        expect(await page.locator(".sidebar-session-tree__loading").count()).toBe(0);
        expect(await child.count()).toBe(1);
      } finally {
        await context.close();
      }
    },
  );

  it("keeps visible sessions ordered and an active child expanded across run completion", async () => {
    const baseTime = Date.parse("2026-08-14T18:00:00.000Z");
    const parentKey = "agent:main:stability-parent";
    const childKey = "agent:main:stability-child";
    const runId = "sidebar-stability-run";
    const siblingRows = Array.from({ length: 10 }, (_, index) => ({
      ...sessionRow(`agent:main:stability-${index}`, `Stable session ${index}`, baseTime - index),
      createdAt: baseTime - index,
    }));
    const parentRow = {
      ...sessionRow(parentKey, "Parent session", baseTime + 100, {
        childSessions: [childKey],
      }),
      createdAt: baseTime + 100,
    };
    const childRow = {
      ...sessionRow(childKey, "Child session", baseTime + 50, {
        hasActiveRun: true,
        spawnedBy: parentKey,
        startedAt: baseTime,
        status: "running",
      }),
      activeRunIds: [runId],
      createdAt: baseTime + 50,
    };
    const expectedVisibleKeys = [
      parentKey,
      childKey,
      ...siblingRows.slice(0, 9).map(({ key }) => key),
    ];
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([parentRow, childRow, ...siblingRows]),
      },
      sessionKey: childKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, childKey));
      const rows = page.locator(".sidebar-recent-session");
      const visibleKeys = () =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-session-key")),
        );
      const childToggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      await expect.poll(visibleKeys, { timeout: 10_000 }).toEqual(expectedVisibleKeys);
      await expect.poll(() => childToggle.getAttribute("aria-expanded")).toBe("true");
      await captureUiProof(suite, page, "sidebar-session-stability-running.png");

      await gateway.emitGatewayEvent("agent", {
        data: { name: "bash" },
        runId,
        sessionKey: childKey,
        stream: "tool",
      });
      expect(await visibleKeys()).toEqual(expectedVisibleKeys);

      const completedChild = {
        ...childRow,
        activeRunIds: [],
        endedAt: baseTime + 200,
        hasActiveRun: false,
        status: "done",
        updatedAt: baseTime + 200,
      };
      await gateway.setSessionsListResponse(
        sessionsListResponse([parentRow, completedChild, ...siblingRows]),
      );
      const listCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [],
        endedAt: completedChild.endedAt,
        hasActiveRun: false,
        key: childKey,
        kind: "direct",
        reason: "lifecycle",
        sessionKey: childKey,
        status: "done",
        updatedAt: completedChild.updatedAt,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listCount);
      await expect.poll(visibleKeys).toEqual(expectedVisibleKeys);

      const nextSessionKey = siblingRows[0]?.key;
      if (!nextSessionKey) {
        throw new Error("expected a visible sibling session");
      }
      await page
        .locator(`[data-session-key="${nextSessionKey}"] a.sidebar-recent-session__link`)
        .click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(nextSessionKey));
      await expect.poll(() => childToggle.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(visibleKeys).toEqual(expectedVisibleKeys);
      await captureUiProof(suite, page, "sidebar-session-stability-completed.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "sidebar-session-stability.webm"));
      }
    }
  });
});
