import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";
import { expectAttribute } from "./sidebar-assertions.test-support.ts";
import { style } from "./sidebar-contract.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("reveals the full active path after Waiting on, direct navigation, and browser history", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const now = Date.UTC(2026, 10, 4, 12);
      const row = (key: string, label: string, parent?: string) => {
        const childSessions: string[] = [];
        return {
          ...sessionRow(key, label, now, { model: "example-model" }),
          kind: "direct",
          status: undefined,
          childSessions,
          parentSessionKey: parent,
          spawnedBy: parent,
        } satisfies GatewaySessionRow;
      };
      const root = row("agent:main:dashboard:release", "Prepare the documentation release");
      const middle = row("agent:main:dashboard:platform", "Check platform documentation", root.key);
      const parent = {
        ...row("agent:main:dashboard:integration", "Review integration examples", middle.key),
        hasActiveSubagentRun: true,
        hasActiveRun: false,
        activeRunIds: [],
        startedAt: now - 60_000,
        endedAt: now - 20_000,
      };
      const siblings = Array.from({ length: 10 }, (_, index) =>
        row(`agent:main:dashboard:example-${index}`, `Validate example ${index + 1}`, parent.key),
      );
      const leaf = {
        ...row("agent:main:dashboard:verification", "Verify the release candidate", parent.key),
        status: "running" as const,
        hasActiveRun: true,
        activeRunIds: ["verification-run"],
        startedAt: now - 30_000,
      };
      const unrelated = row("agent:main:dashboard:website", "Refresh the project website");
      const unrelatedChild = row(
        "agent:main:dashboard:website-links",
        "Check website links",
        unrelated.key,
      );
      const sessions = [root, middle, parent, ...siblings, leaf, unrelated, unrelatedChild];
      for (const session of sessions) {
        session.childSessions = sessions
          .filter((child) => child.parentSessionKey === session.key)
          .map(({ key }) => key);
      }
      await seedChatSettings(page, suite.server.baseUrl, {
        sessionsGrouping: "flat",
        navWidth: 380,
      });
      const gateway = await installMockGateway(page, {
        sessionKey: parent.key,
        sessionInfo: parent,
        sessions,
        historyMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "The examples are ready for the final release verification." },
            ],
            timestamp: now - 30_000,
          },
        ],
      });
      const sidebarRow = (key: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${key}"]`).first();
      const toggle = (key: string) => sidebarRow(key).locator("[data-child-session-toggle]");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      await page.locator(".chat-subagent-wait a").getByText(leaf.label!, { exact: true }).waitFor();
      for (const key of [unrelated.key, parent.key, middle.key, root.key]) {
        if ((await toggle(key).getAttribute("aria-expanded")) !== "true") {
          await toggle(key).focus();
          await page.keyboard.press("Enter");
        }
        await toggle(key).focus();
        await page.keyboard.press("Enter");
        await expectAttribute(toggle(key), "aria-expanded", "false");
      }
      await gateway.setMethodResponse("chat.history", {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Verifying the release candidate against the reviewed integration examples.",
              },
            ],
            timestamp: now,
          },
        ],
        sessionId: leaf.sessionId,
        sessionInfo: leaf,
        inFlightRun: { runId: "verification-run", startedAt: leaf.startedAt },
      });
      await page.locator(".chat-subagent-wait a").getByText(leaf.label!, { exact: true }).click();
      await expect.poll(() => page.url()).toContain("dashboard/verification");
      await page
        .getByText("Verifying the release candidate against the reviewed integration examples.", {
          exact: true,
        })
        .waitFor();
      if (captureUiProofEnabled) {
        const directory = createControlUiE2eArtifactDir("nested-session-reveal");
        await writeFile(
          path.join(directory, "nested-session-reveal.png"),
          (
            await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [
                page.getByText(
                  "Verifying the release candidate against the reviewed integration examples.",
                  { exact: true },
                ),
              ],
              { animations: "disabled" },
            )
          ).png,
        );
      }
      await sidebarRow(leaf.key).waitFor();
      await expectAttribute(
        sidebarRow(leaf.key).locator("a[aria-current]"),
        "aria-current",
        "page",
      );
      for (const key of [root.key, middle.key, parent.key]) {
        await expectAttribute(toggle(key), "aria-expanded", "true");
      }
      await expectAttribute(toggle(unrelated.key), "aria-expanded", "false");
      // A refresh must not reopen an intentional collapse on the same route.
      await toggle(root.key).focus();
      await page.keyboard.press("Enter");
      await gateway.setSessionsListResponse({
        sessions,
        count: sessions.length,
        totalCount: sessions.length,
        hasMore: false,
        offset: 0,
        limitApplied: 50,
        nextOffset: null,
        path: "",
        ts: now + 1,
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "updated",
        sessionKey: leaf.key,
      });
      await expectAttribute(toggle(root.key), "aria-expanded", "false");
      await page.goBack();
      await sidebarRow(parent.key).waitFor();
      await toggle(root.key).focus();
      await page.keyboard.press("Enter");
      await page.goForward();
      await sidebarRow(leaf.key).waitFor();
      await expectAttribute(toggle(root.key), "aria-expanded", "true");
      // A cold direct URL starts with only lineage, before the child lists settle.
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, leaf.key));
      await sidebarRow(leaf.key).waitFor();
      for (const key of [root.key, middle.key, parent.key]) {
        await expectAttribute(toggle(key), "aria-expanded", "true");
      }
    });
  });

  it.each([
    { theme: "light", touch: false },
    { theme: "dark", touch: false },
    { theme: "dark", touch: true },
  ] as const)(
    "keeps child toggles reachable by pointer and keyboard in chip mode ($theme, touch=$touch)",
    async ({ theme, touch }) => {
      await suite.withPage(
        { colorScheme: theme, hasTouch: touch, viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const now = Date.UTC(2026, 9, 14, 12);
          const activeKey = "agent:main:main";
          const parentKey = "agent:main:dashboard:onboarding";
          const active = sessionRow(activeKey, "Home", now);
          const makeChild = (name: string, offset: number) =>
            sessionRow("agent:main:dashboard:" + name, name, now + offset, {
              spawnedBy: parentKey,
              status: undefined,
            });
          const children = ["oauth", "workboard"].map((name, index) => makeChild(name, index + 2));
          const childKeys = children.map((child) => child.key);
          const parent = sessionRow(parentKey, "Mac app onboarding flow testing", now + 1, {
            childSessions: childKeys,
          });
          await page.clock.install();
          await seedChatSettings(page, suite.server.baseUrl, {
            sidebarAgentsMode: "chip",
            themeMode: theme,
            navWidth: 320,
          });
          await installMockGateway(page, {
            sessionKey: activeKey,
            sessions: [active, parent, ...children],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
          const sidebar = page.locator("openclaw-app-sidebar");
          const row = sidebar.locator('[data-session-key="' + parentKey + '"]');
          const toggle = row.locator("[data-child-session-toggle]");
          await toggle.waitFor();
          if ((await toggle.getAttribute("aria-expanded")) === "false") {
            await toggle.click();
          }
          const child = sidebar.locator('[data-session-key="' + childKeys[0] + '"]');
          await child.waitFor();
          await page.mouse.click(1100, 700);
          if (captureUiProofEnabled) {
            const surface = page.locator(".shell-nav");
            await takeControlUiScreenshotFrame(page, surface, [row, child], {
              animations: "disabled",
              elements: [surface],
            });
          }
          expect(await style(toggle, "opacity")).toBe("1");
          expect(await style(toggle, "pointer-events")).not.toBe("none");
          const toggleBox = await toggle.boundingBox();
          const titleBox = await row.locator(".sidebar-recent-session__title-row").boundingBox();
          expect(toggleBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
          expect(await toggle.textContent()).toContain("2");
          await toggle.click();
          await expectAttribute(toggle, "aria-expanded", "false");
          expect(await child.count()).toBe(0);
          await toggle.focus();
          await page.keyboard.press("Enter");
          await child.waitFor();
          expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        },
      );
    },
  );
});
