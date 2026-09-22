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
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

const DETAILS_METHOD = "controlUi.sessionPullRequests.checks";
const headSha = "a".repeat(40);
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
    },
  });
  await page.goto(server.baseUrl + "chat");
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
    const { page } = await setup({ width, height, mode });
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
