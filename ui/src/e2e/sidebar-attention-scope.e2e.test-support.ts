import path from "node:path";
import type { Browser } from "playwright";
import { expect } from "vitest";
import type { CronJob } from "../api/types.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { twoFrames } from "./chat-presentation.test-support.ts";
import { expectCount, expectVisible } from "./sidebar-assertions.test-support.ts";
import { openSidebarPages, sidebarCronJob } from "./sidebar-customization.test-support.ts";
import { setSidebarProofTheme } from "./sidebar-footer-proof.test-support.ts";

type SidebarAttentionScopeFlowOptions = {
  artifactDir: string;
  baseUrl: string;
  browser: Browser;
  captureProof: boolean;
};

export async function runSidebarAttentionScopeFlow(params: SidebarAttentionScopeFlowOptions) {
  const context = await params.browser.newContext({
    locale: "en-US",
    recordVideo: params.captureProof
      ? { dir: params.artifactDir, size: { height: 900, width: 1440 } }
      : undefined,
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  const proofVideo = page.video();
  const captureProof = async (fileName: string, hold = false) => {
    if (!params.captureProof) {
      return;
    }
    if (hold) {
      await page.waitForTimeout(600);
    }
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(params.artifactDir, fileName),
    });
  };
  const failedJob = (agent: "main" | "writer", id = agent + "-release-digest") =>
    sidebarCronJob({
      id,
      agentId: agent,
      name: (agent === "main" ? "Main" : "Writer") + " release digest",
    });
  const mainJob = failedJob("main");
  const writerJob = failedJob("writer");
  const cronResponse = (jobs: CronJob[]) => ({
    jobs,
    snapshotRevision: `sidebar-agent-scope-${jobs.map((job) => job.id).join("-")}`,
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  });
  const scopedCronResponses = (writer: CronJob) =>
    cronListResponseFixture([
      { match: { agentId: "main" }, response: cronResponse([mainJob]) },
      { match: { agentId: "writer" }, response: cronResponse([writer]) },
      { response: cronResponse([mainJob, writer]) },
    ]);
  const gateway = await installMockGateway(page, {
    presenceUsers: [{ self: true, id: "alice", name: "Alice" }],
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
        agents: [
          { id: "main", identity: { name: "Main" }, name: "Main" },
          { id: "writer", identity: { name: "Writer" }, name: "Writer" },
        ],
      },
      "cron.list": scopedCronResponses(writerJob),
      "models.authStatus": { providers: [], ts: 1 },
    },
  });
  const cronScopeRequestCount = async (agentId: string | null) =>
    (await gateway.getRequests("cron.list")).filter((request) => {
      const requestParams = request.params as Record<string, unknown> | undefined;
      return agentId === null
        ? Boolean(requestParams && !Object.hasOwn(requestParams, "agentId"))
        : requestParams?.agentId === agentId;
    }).length;
  const waitForCronScope = async (agentId: string | null) => {
    await expect.poll(() => cronScopeRequestCount(agentId)).toBeGreaterThan(0);
  };

  try {
    await page.goto(`${params.baseUrl}new`);
    await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
    await setSidebarProofTheme(page, "dark");
    await waitForCronScope("main");
    await gateway.emitGatewayEvent("exec.approval.requested", {
      id: "approval-global",
      createdAtMs: 1_000,
      expiresAtMs: Date.now() + 60_000,
      request: {
        command: "pnpm test:changed",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });
    const sidebar = page.locator("openclaw-app-sidebar");
    const automationRows = sidebar.locator('[data-attention-kind="cronFailed"]');
    const approvalRow = sidebar.locator('[data-approval-id="approval-global"]');
    const expectAutomations = async (main: number, writer: number) => {
      await expect
        .poll(async () => ({
          main: await automationRows.getByText("Main release digest").count(),
          writer: await automationRows.getByText("Writer release digest").count(),
        }))
        .toEqual({ main, writer });
    };
    const openAutomations = async () => {
      await sidebar.locator(".sidebar-issues-button").click();
      await expectCount(approvalRow, 1);
      await sidebar.getByRole("tab", { name: /Automations/ }).click();
    };

    await openAutomations();
    await expectAutomations(1, 0);
    const mainDismiss = automationRows.getByRole("button", {
      name: "Dismiss Main release digest",
    });
    await expect
      .poll(() =>
        mainDismiss.evaluate((element) => {
          const { opacity, pointerEvents } = getComputedStyle(element);
          return { opacity, pointerEvents };
        }),
      )
      .toEqual({ opacity: "1", pointerEvents: "auto" });
    await captureProof("08-desktop-inbox-main-agent.png", true);
    const mainAutomationChevron = automationRows
      .filter({ hasText: "Main release digest" })
      .locator(".sidebar-issues-panel__chevron");
    const mainAutomationChevronBox = await mainAutomationChevron.boundingBox();
    if (!mainAutomationChevronBox) {
      throw new Error("Main release digest chevron has no bounding box");
    }
    await page.mouse.click(
      mainAutomationChevronBox.x + mainAutomationChevronBox.width / 2,
      mainAutomationChevronBox.y + mainAutomationChevronBox.height / 2,
    );
    await captureProof("08a-desktop-inbox-chevron-click-result.png");
    await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });
    await captureProof("08b-desktop-inbox-chevron-navigation.png");
    await page.goBack();
    await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });

    await sidebar.getByRole("button", { name: /Switch agent/ }).click();
    await sidebar.locator('.sidebar-agent-menu [data-value="agent:writer"]').click();
    await waitForCronScope("writer");
    // The agent's cron refresh can precede the Chat route commit that closes Inbox.
    await waitForControlUiRoute(page, { pathname: "/chat/writer", routeId: "chat" });
    await openAutomations();
    await expectAutomations(0, 1);
    await captureProof("09-desktop-inbox-writer-agent.png", true);
    await sidebar.locator(".sidebar-issues-button").click();

    const pages = await openSidebarPages(page);
    await pages.getByRole("link", { name: "Automations", exact: true }).click();
    await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });
    const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
    await pageScope.locator(".agent-select__trigger").click();
    await pageScope
      .locator(".agent-select__option[data-agent-option]")
      .filter({ hasText: "All agents" })
      .click();
    await waitForCronScope(null);
    await openAutomations();
    await expectAutomations(1, 1);
    for (const owner of ["Main", "Writer"]) {
      const ownerLabel = automationRows
        .filter({ hasText: owner + " release digest" })
        .locator(".sidebar-issues-panel__meta-context");
      await expect.poll(() => ownerLabel.textContent()).toBe(owner);
    }
    await captureProof("10-desktop-inbox-all-agents.png", true);

    await automationRows
      .filter({ hasText: "Writer release digest" })
      .getByRole("button", { name: "Dismiss Writer release digest" })
      .click();
    await expectCount(automationRows.getByText("Writer release digest"), 0);
    await sidebar.locator(".sidebar-issues-button").click();

    const selectPageScope = async (label: string, agentId: string | null) => {
      const previousCount = await cronScopeRequestCount(agentId);
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: label })
        .click();
      await expect.poll(() => cronScopeRequestCount(agentId)).toBeGreaterThan(previousCount);
    };
    await selectPageScope("Main", "main");
    await selectPageScope("All agents", null);
    await openAutomations();
    await expectAutomations(1, 0);
    await sidebar.locator(".sidebar-issues-button").click();

    const writerJobNext = failedJob("writer", "writer-release-digest-next");
    await gateway.setMethodResponse("cron.list", scopedCronResponses(writerJobNext));
    const previousAllCount = await cronScopeRequestCount(null);
    await gateway.emitGatewayEvent("cron", {});
    await expect.poll(() => cronScopeRequestCount(null)).toBeGreaterThan(previousAllCount);
    await selectPageScope("Writer", "writer");
    const upstream = {
      commitsBehind: 246,
      upstreamRef: "origin/main",
      upstreamSha: "9f3c21a0000000000000000000000000000000aa",
    };
    await gateway.emitGatewayEvent("update.available", {
      schedule: {
        autoEnabled: false,
        channel: "beta",
        install: { kind: "git", git: { status: "behind", commitsBehind: 246 } },
        target: { kind: "git", ...upstream },
      },
      updateAvailable: {
        channel: "beta",
        ...upstream,
        currentSha: "1111111111111111111111111111111111111111",
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.1",
      },
    });

    const sidebarUpdate = sidebar.locator(
      'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
    );
    await expectCount(sidebar.locator(".sidebar-issues-button__count"), 1);
    await sidebar.locator(".sidebar-issues-button").click();
    await expectCount(sidebarUpdate, 1);
    await expectAutomations(0, 1);
    await sidebar.locator(".sidebar-issues-button").click();

    await page.setViewportSize({ height: 852, width: 393 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
    await twoFrames(page);
    const floatingKinds = await page
      .locator(".sidebar-attention--floating [data-attention-kind]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-attention-kind")),
      );
    await navigationDrawerToggle(page).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    await sidebar.locator(".sidebar-issues-button").click();
    await expectVisible(sidebarUpdate);
    await expectCount(approvalRow, 1);
    await sidebar.getByRole("tab", { name: /Automations/ }).click();
    await expectAutomations(0, 1);
    await captureProof("11-mobile-inbox-writer-agent.png", true);

    await sidebar.getByRole("button", { name: "Dismiss shown" }).click();
    await expectCount(automationRows, 0);
    await sidebar.getByRole("tab", { name: /All/ }).click();
    await expectCount(approvalRow, 1);
    await expectVisible(sidebarUpdate);
    await captureProof("12-mobile-inbox-dismissed-alerts.png", true);

    expect(floatingKinds).toEqual([]);
  } catch (error) {
    await captureControlUiE2eFailureDiagnostics(page, {
      error: error instanceof Error ? error : new Error(String(error)),
      label: "Control UI Inbox automation scope",
    });
    throw error;
  } finally {
    await context.close();
    if (proofVideo) {
      await proofVideo.saveAs(path.join(params.artifactDir, "inbox-agent-scope.webm"));
    }
  }
}
