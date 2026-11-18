import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { sessionClassificationForRow } from "../../../src/gateway/session-classification.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { expectCount, expectText } from "./sidebar-assertions.test-support.ts";
import { openSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("keeps publication custody out of the conversation tree and available in system views", async () => {
    const parentKey = "agent:main:dashboard:publication-parent";
    const now = Date.parse("2026-11-16T12:00:00Z");
    // Both deployed producers: per-invocation UUIDs and stable checkout hashes.
    const tasks = [
      ["github-00000000-0000-8000-8000-000000000001", "00000000-0000-8000-8000-000000000001"],
      ["github-publication-0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"],
    ].map(([suffix, id]) => {
      const key = `agent:main:dashboard:${suffix}`;
      const entry = {
        sessionId: id!,
        updatedAt: now,
        parentSessionKey: parentKey,
        createdVia: "spawn" as const,
        createdActor: { type: "agent" as const, id: "main" },
      };
      return sessionRow(key, "GitHub publication", now, {
        ...entry,
        // Gateway row projection omits generated custody labels; raw storage retains them.
        ...sessionClassificationForRow({}, key, "main", entry),
      });
    });
    const child = sessionRow("agent:main:dashboard:human-child", "Review the changes", now - 1, {
      parentSessionKey: parentKey,
      createdVia: "spawn",
      createdActor: { type: "agent", id: "main" },
    });
    const children = [...tasks, child];
    const parent = sessionRow(parentKey, "Knowledge tool call shapes", now, {
      childSessions: children.map((row) => row.key),
    });
    const other = sessionRow("agent:main:dashboard:other", "Unrelated work", now - 2);
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: parentKey,
        sessions: [parent, other, ...children],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { spawnedBy: parentKey }, response: sessionsListResponse(children) },
              { response: sessionsListResponse([parent, other]) },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      await toggle.waitFor({ state: "visible" });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await page.locator(`[data-session-key="${child.key}"]`).waitFor({ state: "visible" });
      if (captureUiProofEnabled) {
        const sidebar = page.locator(".sidebar-shell");
        const frame = await takeControlUiScreenshotFrame(page, sidebar, [toggle], {
          elements: [toggle],
          animations: "disabled",
        });
        const annotations = [
          {
            kind: "outline" as const,
            rect: frame.elements[0]!.bounds,
            text: "Conversation children",
            labelAt: { x: 380, y: 130 },
            color: "#e87924",
          },
        ];
        await writeFile(path.join(suite.artifactDir, "publication-clean.png"), frame.png);
        await writeFile(
          path.join(suite.artifactDir, "publication-annotated.png"),
          await rasterizeProofAnnotations(suite.browser, {
            viewport: page.viewportSize()!,
            scale: await page.evaluate(() => devicePixelRatio),
            annotations,
            image: frame.png,
          }),
        );
        console.log("PUBLICATION_UI_PROOF", suite.artifactDir);
      }
      await expectText(toggle.locator(".sidebar-child-session-toggle__count"), "1");
      for (const task of tasks) {
        await expectCount(page.locator(`[data-session-key="${task.key}"]`), 0);
      }
      await openSidebarMenu(page);
      await page.getByRole("switch", { name: "Show system sessions" }).click();
      await page.keyboard.press("Escape");
      await expectText(toggle.locator(".sidebar-child-session-toggle__count"), "3");
      for (const task of tasks) {
        const row = page.locator(`[data-session-key="${task.key}"]`);
        await expectCount(row, 1);
        expect(await row.textContent()).toContain("GitHub publication");
        expect(await row.textContent()).not.toContain("github-publication-");
      }
      await openSidebarMenu(page);
      await page.getByRole("switch", { name: "Show system sessions" }).click();
      await page.keyboard.press("Escape");
      await page.reload();
      await expectText(toggle.locator(".sidebar-child-session-toggle__count"), "1");
      await expectCount(page.locator(`[data-session-key="${other.key}"]`), 1);
    });
  });
});
