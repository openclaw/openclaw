import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  installMockGateway,
} from "./session-management.test-support.ts";
import { expectAttribute } from "./sidebar-assertions.test-support.ts";

export async function runActiveSessionRevealScenario(page: Page, baseUrl: string): Promise<void> {
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
  const root = {
    ...row("agent:main:dashboard:release", "Prepare the documentation release"),
    category: "Documentation",
  };
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
  const unrelated = {
    ...row("agent:main:dashboard:website", "Refresh the project website"),
    category: "Website",
  };
  const unrelatedChild = {
    ...row("agent:main:dashboard:website-links", "Check website links", unrelated.key),
    hasActiveRun: true,
    activeRunIds: ["website-run"],
  };
  const sessions = [root, middle, parent, ...siblings, leaf, unrelated, unrelatedChild];
  for (const session of sessions) {
    session.childSessions = sessions
      .filter((child) => child.parentSessionKey === session.key)
      .map(({ key }) => key);
  }
  await seedChatSettings(page, baseUrl, {
    sessionsGrouping: "category",
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
  const sectionToggle = (id: string) =>
    page.locator('[data-session-section="' + id + '"] .sidebar-session-group-toggle').first();
  const documentation = sectionToggle("category:Documentation");
  const website = sectionToggle("category:Website");
  await page.goto(controlUiSessionUrl(baseUrl, parent.key));
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
  for (const section of [documentation, website]) {
    await expectAttribute(section, "aria-expanded", "true");
    await section.focus();
    await page.keyboard.press("Enter");
    await expectAttribute(section, "aria-expanded", "false");
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
  await expectAttribute(sidebarRow(leaf.key).locator("a[aria-current]"), "aria-current", "page");
  for (const key of [root.key, middle.key, parent.key]) {
    await expectAttribute(toggle(key), "aria-expanded", "true");
  }
  await expectAttribute(website, "aria-expanded", "false");
  await website.focus();
  await page.keyboard.press("Enter");
  await expectAttribute(toggle(unrelated.key), "aria-expanded", "false");
  await website.focus();
  await page.keyboard.press("Enter");
  await expectAttribute(documentation, "aria-expanded", "true");
  await expectAttribute(website, "aria-expanded", "false");
  // A refresh must not reopen an intentional collapse on the same route.
  await toggle(root.key).focus();
  await page.keyboard.press("Enter");
  await expectAttribute(toggle(root.key), "aria-expanded", "false");
  await documentation.focus();
  await page.keyboard.press("Enter");
  await expectAttribute(documentation, "aria-expanded", "false");
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
  expect(await sidebarRow(root.key).count()).toBe(0);
  await expectAttribute(documentation, "aria-expanded", "false");
  await page.goBack();
  await expect.poll(() => page.url()).toContain("dashboard/integration");
  await sidebarRow(parent.key).locator("a[aria-current='page']").waitFor();
  await expectAttribute(documentation, "aria-expanded", "true");
  for (const key of [parent.key, middle.key, root.key]) {
    if ((await toggle(key).getAttribute("aria-expanded")) === "true") {
      await toggle(key).focus();
      await page.keyboard.press("Enter");
    }
    await expectAttribute(toggle(key), "aria-expanded", "false");
  }
  await documentation.focus();
  await page.keyboard.press("Enter");
  await expectAttribute(documentation, "aria-expanded", "false");
  expect(await sidebarRow(leaf.key).count()).toBe(0);
  await page.goForward();
  await expect.poll(() => page.url()).toContain("dashboard/verification");
  await sidebarRow(leaf.key).locator("a[aria-current='page']").waitFor();
  for (const key of [root.key, middle.key, parent.key]) {
    await expectAttribute(toggle(key), "aria-expanded", "true");
  }
  await expectAttribute(documentation, "aria-expanded", "true");
  await expectAttribute(website, "aria-expanded", "false");
  // A cold direct URL starts with only lineage, before the child lists settle.
  await documentation.focus();
  await page.keyboard.press("Enter");
  await expectAttribute(documentation, "aria-expanded", "false");
  await page.goto(controlUiSessionUrl(baseUrl, leaf.key));
  await sidebarRow(leaf.key).waitFor();
  await expectAttribute(documentation, "aria-expanded", "true");
  await expectAttribute(website, "aria-expanded", "false");
  for (const key of [root.key, middle.key, parent.key]) {
    await expectAttribute(toggle(key), "aria-expanded", "true");
  }
}
