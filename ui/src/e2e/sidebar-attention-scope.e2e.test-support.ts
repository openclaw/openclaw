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
  const mainJob = { ...failedJob("main"), state: { lastRunStatus: "ok" as const, nextRunAtMs: 1 } };
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
    const dot = sidebar.locator(".sidebar-rail .sidebar-automations__failed");
    const clock = sidebar.getByRole("link", { name: "Automations", exact: true });
    const inbox = sidebar.locator(".sidebar-issues-button");
    const approvalRow = sidebar.locator('[data-approval-id="approval-global"]');
    await inbox.click();
    await expectCount(approvalRow, 1);
    await expectCount(dot, 0);
    expect(
      await sidebar
        .locator("#sidebar-issues-panel")
        .getByText("Main release digest", { exact: true })
        .count(),
    ).toBe(0);
    await inbox.click();

    await sidebar.getByRole("button", { name: /Switch agent/ }).click();
    await sidebar.locator('.sidebar-agent-menu [data-value="agent:writer"]').click();
    await waitForCronScope("writer");
    await waitForControlUiRoute(page, { pathname: "/chat/writer", routeId: "chat" });
    await expectVisible(dot);
    await captureProof("desktop-automation-rail.png");
    await clock.click();
    await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });
    await expectVisible(dot);

    const pages = await openSidebarPages(page);
    await pages.getByRole("link", { name: "Usage", exact: true }).click();
    await waitForControlUiRoute(page, { pathname: "/usage", routeId: "usage" });
    const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
    const selectScope = async (label: string, agentId: string | null) => {
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: label })
        .click();
      await expect.poll(() => pageScope.locator(".agent-select__label").textContent()).toBe(label);
      await waitForCronScope(agentId);
    };
    await selectScope("All agents", null);
    await expectVisible(dot);
    await selectScope("Main", "main");
    await expectCount(dot, 0);
    await selectScope("Writer", "writer");
    await expectVisible(dot);

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
    await expectVisible(dot);
    expect(
      await sidebar
        .locator("#sidebar-issues-panel")
        .getByText("Writer release digest", { exact: true })
        .count(),
    ).toBe(0);
    await sidebar.locator(".sidebar-issues-button").click();

    await page.setViewportSize({ height: 852, width: 393 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
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
    await sidebar.getByRole("tab", { name: /System/ }).click();
    await expectVisible(dot);
    expect(
      await sidebar
        .locator("#sidebar-issues-panel")
        .getByText("Writer release digest", { exact: true })
        .count(),
    ).toBe(0);
    await captureProof("11-mobile-inbox-writer-agent.png", true);

    await sidebar.locator(".sidebar-issues-panel__more").click();
    await sidebar.getByRole("menuitem", { name: "Dismiss shown" }).click();
    await expectCount(sidebarUpdate, 0);
    await expectVisible(dot);
    await sidebar.getByRole("tab", { name: /All/ }).click();
    await expectCount(approvalRow, 1);
    await captureProof("12-mobile-inbox-dismissed-alerts.png", true);

    expect(floatingKinds).toEqual([]);
  } catch (error) {
    await captureControlUiE2eFailureDiagnostics(page, {
      error: error instanceof Error ? error : new Error(String(error)),
      label: "Control UI automation failure indicator scope",
    });
    throw error;
  } finally {
    await context.close();
    if (proofVideo) {
      await proofVideo.saveAs(path.join(params.artifactDir, "inbox-agent-scope.webm"));
    }
  }
}
