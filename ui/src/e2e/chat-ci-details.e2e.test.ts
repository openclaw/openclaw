import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
  type ControlUiSessionPullRequestCheck,
  type ControlUiSessionPullRequestCheckDetails,
} from "../../../src/gateway/control-ui-contract.js";
import type { CronJob } from "../api/types.ts";
import { ciAutomationJobSpec, type CiAutomationOption } from "../lib/session-pr-automation-spec.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

const DETAILS_METHOD = "controlUi.sessionPullRequests.checks";
const headSha = "a".repeat(40);
const automationSessionKey = "agent:main:dashboard:ci-proof";
const automationSessionId = "ci-proof-incarnation";
function automationInventory(jobs: CronJob[]) {
  return cronListResponseFixture({
    jobs,
    total: jobs.length,
    limit: 50,
    offset: 0,
    hasMore: false,
    nextOffset: null,
    snapshotRevision: "ci-automation-inventory",
  });
}
function automationJob(option: CiAutomationOption, enabled = true): CronJob {
  return {
    ...ciAutomationJobSpec(
      {
        sessionKey: automationSessionKey,
        sessionId: automationSessionId,
        agentId: "main",
        owner: "openclaw",
        repo: "openclaw",
        number: 123456,
      },
      option,
    ),
    id: option,
    enabled,
    createdAtMs: 1,
    updatedAtMs: 1,
    configRevision: "automation-v1",
    state: { nextRunAtMs: Date.now() + 300_000 },
  };
}
const pullRequest: ControlUiSessionPullRequest = {
  number: 123456,
  owner: "openclaw",
  repo: "openclaw",
  branch: "feature/ci-details",
  title: "Show CI jobs and steps in the chat popover",
  url: "https://github.com/openclaw/openclaw/pull/123456",
  state: "open",
  headSha,
  additions: 210,
  deletions: 30,
  checks: { state: "pending", passed: 6, failed: 0, running: 1, skipped: 17 },
  checksUrl: "https://github.com/openclaw/openclaw/pull/123456/checks",
};

function detailFixture(
  mode: "running" | "failed" | "passed" = "running",
): ControlUiSessionPullRequestCheckDetails {
  const startedAtMs = Date.now() - (mode === "running" ? 139_000 : 142_000);
  const stamp = (seconds: number) => new Date(startedAtMs + seconds * 1000).toISOString();
  const completed = mode !== "running";
  const steps = [
    { name: "Set up job", start: 0, end: 2 },
    { name: "Checkout repository", start: 2, end: 5 },
    { name: "Set up Node.js", start: 5, end: 13 },
    { name: "Install dependencies", start: 13, end: 37 },
    { name: "Run tests", start: 37, end: 139 },
    { name: "Upload test results", start: 139, end: 141 },
    { name: "Post-job cleanup", start: 141, end: 142 },
  ];
  const active: ControlUiSessionPullRequestCheck = {
    id: 11,
    name: "Tests — Linux",
    state: mode,
    source: "actions",
    status: completed ? "completed" : "in_progress",
    ...(completed
      ? { conclusion: mode === "failed" ? "failure" : "success", completedAt: stamp(142) }
      : {}),
    startedAt: stamp(0),
    detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/100/job/11",
    steps: steps.map(({ name, start, end }, index) => ({
      number: index + 1,
      name,
      status: completed || index < 4 ? "completed" : index === 4 ? "in_progress" : "queued",
      conclusion:
        completed || index < 4
          ? mode === "failed" && index === 4
            ? "failure"
            : "success"
          : undefined,
      completedAt: completed || index < 4 ? stamp(end) : undefined,
      startedAt: completed || index <= 4 ? stamp(start) : undefined,
    })),
  };
  const passed: ControlUiSessionPullRequestCheck[] = [
    "Lint",
    "Typecheck",
    "Tests — macOS",
    "Tests — Windows",
    "Build",
    "Dependency review",
  ].map((name, index) => ({
    id: 20 + index,
    name,
    state: "passed",
    source: index === 5 ? "check" : "actions",
    status: "completed",
    conclusion: "success",
    startedAt: stamp(0),
    completedAt: stamp(42 + index * 10),
    detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/100/job/" + (20 + index),
    steps:
      index === 5
        ? undefined
        : [
            {
              number: 1,
              name: "Run " + name.toLowerCase(),
              status: "completed",
              conclusion: "success",
              startedAt: stamp(0),
              completedAt: stamp(42 + index * 10),
            },
          ],
  }));
  const skipped: ControlUiSessionPullRequestCheck[] = Array.from({ length: 17 }, (_, index) => ({
    id: 40 + index,
    name: index === 0 ? "Android build" : "Optional platform check " + (index + 1),
    state: "skipped",
    source: "actions",
    status: "completed",
    conclusion: "skipped",
    steps: [],
  }));
  return {
    owner: "openclaw",
    repo: "openclaw",
    number: pullRequest.number,
    headSha,
    checks: [...passed, active, ...skipped],
    status: "ready",
    rateLimited: false,
  };
}

let browser: Browser;
let server: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

async function setup(
  options: {
    width?: number;
    height?: number;
    mode?: "running" | "failed" | "passed";
    defer?: boolean;
    automationJobs?: CronJob[];
    schedulerEnabled?: boolean;
    readOnly?: boolean;
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1180, height: options.height ?? 960 },
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
  });
  contexts.add(context);
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    sessionKey: automationSessionKey,
    sessions: [
      {
        key: automationSessionKey,
        sessionId: automationSessionId,
        label: "CI review",
        kind: "direct",
        updatedAt: 1,
      },
    ],
    operatorScopes: options.readOnly ? ["operator.read"] : undefined,
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      DETAILS_METHOD,
    ],
    historyMessages: [
      { role: "assistant", content: "The implementation is ready for CI review.", timestamp: 1 },
    ],
    methodResponses: {
      [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      [DETAILS_METHOD]: detailFixture(options.mode),
      "cron.list": automationInventory(options.automationJobs ?? []),
      "cron.status": {
        enabled: options.schedulerEnabled ?? true,
        triggersEnabled: true,
        jobs: options.automationJobs?.length ?? 0,
      },
    },
  });
  await page.goto(controlUiSessionUrl(server.baseUrl, automationSessionKey));
  if (options.defer) {
    await gateway.deferNext(DETAILS_METHOD);
  }
  const sessionKey = await waitForWatchedSessionKey(gateway);
  async function publish(next: ControlUiSessionPullRequest = pullRequest) {
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [sessionKey]: { pullRequests: [next], rateLimited: false, status: "ready" } },
    });
    await page.locator(".chat-pr__checks-pill").waitFor();
  }
  await publish(
    options.mode === "failed"
      ? {
          ...pullRequest,
          checks: { state: "failing", passed: 6, failed: 1, running: 0, skipped: 17 },
        }
      : options.mode === "passed"
        ? {
            ...pullRequest,
            checks: { state: "passing", passed: 7, failed: 0, running: 0, skipped: 17 },
          }
        : pullRequest,
  );
  return { page, gateway, sessionKey, publish };
}

async function expandLinuxJob(page: Page) {
  const job = page
    .locator(".chat-pr__checks-menu details")
    .filter({ has: page.locator("summary", { hasText: "Tests — Linux" }) })
    .first();
  await job.waitFor();
  if (!(await job.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await job.locator("summary").first().click();
  }
  await page.getByText("Install dependencies", { exact: true }).waitFor();
  return job;
}

describe("chat CI job and step details", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    server = await startControlUiE2eServer();
  });
  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("saves exact-session automation toggles and reconciles an uncertain write", async () => {
    const fix = automationJob("autoFix");
    const merge = automationJob("autoMerge", false);
    const { page, gateway, publish } = await setup({ automationJobs: [fix, merge] });
    await page.locator(".chat-pr__checks-pill").click();
    const autoFix = page.getByRole("checkbox", { name: "Auto-fix CI & address comments" });
    const autoMerge = page.getByRole("checkbox", { name: "Auto-merge when ready" });
    const autoArchive = page.getByRole("checkbox", { name: "Auto-archive on merge or close" });
    await expect.poll(() => autoFix.isChecked()).toBe(true);
    await expect.poll(() => autoMerge.isEnabled()).toBe(true);
    expect(await autoMerge.isChecked()).toBe(false);
    await gateway.deferNext("cron.update");
    await autoFix.click();
    const update = await gateway.waitForRequest("cron.update");
    expect(update.params).toEqual({
      id: "autoFix",
      expectedConfigRevision: "automation-v1",
      patch: { enabled: false },
    });
    expect(await autoMerge.isDisabled()).toBe(true);
    const disabledFix = { ...fix, enabled: false, configRevision: "automation-v2" };
    await gateway.setMethodResponse("cron.list", automationInventory([disabledFix, merge]));
    await gateway.resolveDeferred("cron.update", disabledFix);
    await expect.poll(() => autoArchive.isEnabled()).toBe(true);
    expect(await autoFix.isChecked()).toBe(false);

    await gateway.deferNext("cron.add");
    await autoArchive.click();
    const add = await gateway.waitForRequest("cron.add");
    expect(add.params).toMatchObject({
      agentId: "main",
      sessionKey: automationSessionKey,
      owner: { agentId: "main", sessionKey: automationSessionKey },
      sessionTarget: "isolated",
      enabled: true,
      schedule: { kind: "every", everyMs: 300_000 },
      payload: { kind: "agentTurn", message: expect.stringContaining(automationSessionId) },
    });
    const archive = automationJob("autoArchive");
    await gateway.setMethodResponse(
      "cron.list",
      automationInventory([disabledFix, merge, archive]),
    );
    await gateway.rejectDeferred("cron.add", {
      code: "UNAVAILABLE",
      message: "Connection lost after saving",
    });
    await page.getByText("Connection lost after saving", { exact: false }).waitFor();
    expect(await autoMerge.isDisabled()).toBe(true);
    const retry = page.locator(".chat-ci__automation-retry");
    expect(await retry.isEnabled()).toBe(true);
    await retry.click();
    await expect.poll(() => autoArchive.isEnabled()).toBe(true);
    expect(await autoArchive.isChecked()).toBe(true);
    expect(await gateway.getRequests("cron.add")).toHaveLength(1);

    await page.locator(".chat-pr__checks-pill").click();
    await publish({ ...pullRequest, headSha: "c".repeat(40) });
    await page.locator(".chat-pr__checks-pill").click();
    await expect.poll(() => autoArchive.isEnabled()).toBe(true);
    expect(await autoArchive.isChecked()).toBe(true);
    expect(await autoFix.isChecked()).toBe(false);
  });

  it("shows stored automation state without checks and enforces read-only access", async () => {
    const { page, gateway, publish } = await setup({
      readOnly: true,
      automationJobs: [automationJob("autoMerge")],
    });
    await publish({ ...pullRequest, checks: undefined });
    await page.locator(".chat-pr__checks-pill").click();
    const autoMerge = page.getByRole("checkbox", { name: "Auto-merge when ready" });
    await expect.poll(() => autoMerge.isChecked()).toBe(true);
    expect(await autoMerge.isDisabled()).toBe(true);
    expect(await gateway.getRequests("cron.add")).toHaveLength(0);
    expect(await gateway.getRequests("cron.update")).toHaveLength(0);
    expect(await gateway.getRequests(DETAILS_METHOD)).toHaveLength(0);
  });

  it("loads steps only after opening and keeps skipped work collapsed", async () => {
    const { page, gateway, sessionKey } = await setup({ defer: true });
    expect(await gateway.getRequests(DETAILS_METHOD)).toHaveLength(0);
    await page.locator(".chat-pr__checks-pill").click();
    const request = await gateway.waitForRequest(DETAILS_METHOD);
    expect(request.params).toMatchObject({
      sessionKey,
      owner: "openclaw",
      repo: "openclaw",
      number: pullRequest.number,
      headSha,
    });
    await gateway.resolveDeferred(DETAILS_METHOD, detailFixture());
    const job = await expandLinuxJob(page);
    expect(await job.textContent()).toContain("Run tests");
    expect(
      await job
        .locator('a[href="https://github.com/openclaw/openclaw/actions/runs/100/job/11"]')
        .count(),
    ).toBeGreaterThan(0);
    const skipped = page
      .locator(".chat-pr__checks-menu details")
      .filter({ has: page.locator("summary", { hasText: /17.*skipped/i }) })
      .first();
    await skipped.waitFor();
    expect(await skipped.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    await skipped.locator("summary").first().click();
    await page.getByText("Android build", { exact: true }).waitFor();
    expect(await page.locator(".chat-pr__checks-menu footer").count()).toBe(0);
    expect(await page.getByText("Auto-refresh while open", { exact: false }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".chat-pr__checks[open]").count()).toBe(0);
    await expect.poll(() => page.locator(".chat-pr__checks-menu").isVisible()).toBe(false);
  });

  it("does not display a pending response for the previous commit", async () => {
    const { page, gateway, publish } = await setup({ defer: true });
    await page.locator(".chat-pr__checks-pill").click();
    await gateway.waitForRequest(DETAILS_METHOD);
    const replacement = {
      ...detailFixture(),
      headSha: "b".repeat(40),
      checks: [
        {
          id: 100,
          name: "New commit build",
          state: "passed" as const,
          source: "check" as const,
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    await gateway.setMethodResponse(DETAILS_METHOD, replacement);
    await publish({ ...pullRequest, headSha: replacement.headSha });
    await gateway.resolveDeferred(DETAILS_METHOD, detailFixture());
    await page.getByText("New commit build", { exact: true }).waitFor();
    expect(await page.getByText("Tests — Linux", { exact: true }).count()).toBe(0);
  });

  it.each([
    { label: "desktop", width: 1180, height: 960, mode: "running" as const },
    { label: "desktop-passed", width: 1180, height: 960, mode: "passed" as const },
    { label: "mobile", width: 393, height: 960, mode: "failed" as const },
    { label: "landscape", width: 844, height: 390, mode: "failed" as const },
  ])("keeps expanded steps usable on $label", async ({ label, width, height, mode }) => {
    const { page } = await setup({
      width,
      height,
      mode,
      automationJobs: [automationJob("autoFix"), automationJob("autoMerge")],
    });
    await page.locator(".chat-pr__checks-pill").click();
    await expandLinuxJob(page);
    const menu = page.locator(".chat-pr__checks-menu");
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await menu.getByRole("link", { name: "Open checks on GitHub" }).click({ trial: true });
    const linuxJob = menu.locator('.chat-ci__job[data-check-id="11"]');
    await linuxJob.locator(".chat-ci__job-link").click({ trial: true });
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const output = createControlUiE2eArtifactDir("ci-details-" + label);
      await writeFile(
        path.join(output, "after-" + label + ".png"),
        await takeControlUiViewportScreenshot(page, menu, [
          page.getByText("Install dependencies", { exact: true }),
        ]),
      );
      const row = await page.locator(".chat-pr").first().boundingBox();
      if (bounds && row) {
        const x = Math.max(0, Math.floor(Math.min(bounds.x, row.x) - 14));
        const y = Math.max(0, Math.floor(bounds.y - 14));
        await page.screenshot({
          path: path.join(output, "after-" + label + "-crop.png"),
          animations: "disabled",
          clip: {
            x,
            y,
            width: Math.min(
              width - x,
              Math.ceil(Math.max(bounds.x + bounds.width, row.x + row.width) - x + 14),
            ),
            height: Math.min(height - y, Math.ceil(row.y + row.height - y + 14)),
          },
        });
      }
    }
  });
});
