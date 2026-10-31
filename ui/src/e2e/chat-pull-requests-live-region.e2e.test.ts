import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../../src/gateway/control-ui-contract.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:dashboard:pr-announcement";
const sessionId = "pr-announcement-incarnation";
const headSha = "a".repeat(40);

type Checks = NonNullable<ControlUiSessionPullRequest["checks"]>;

const running: Checks = { state: "pending", passed: 4, failed: 0, running: 2, skipped: 0 };
const failing: Checks = { state: "failing", passed: 3, failed: 1, running: 0, skipped: 0 };
const passing: Checks = { state: "passing", passed: 6, failed: 0, running: 0, skipped: 0 };
const progressed: Checks = { state: "pending", passed: 5, failed: 0, running: 1, skipped: 0 };

const running101 =
  "openclaw/openclaw#101: CI checks running (4 passed, 0 failed, 2 running, 0 skipped)";
const running102 =
  "openclaw/openclaw#102: CI checks running (4 passed, 0 failed, 2 running, 0 skipped)";
const progressed101 =
  "openclaw/openclaw#101: CI checks running (5 passed, 0 failed, 1 running, 0 skipped)";
const failing101 =
  "openclaw/openclaw#101: CI checks failing (3 passed, 1 failed, 0 running, 0 skipped)";
const failing102 =
  "openclaw/openclaw#102: CI checks failing (3 passed, 1 failed, 0 running, 0 skipped)";
const passing101 =
  "openclaw/openclaw#101: CI checks passing (6 passed, 0 failed, 0 running, 0 skipped)";
const passing102 =
  "openclaw/openclaw#102: CI checks passing (6 passed, 0 failed, 0 running, 0 skipped)";

function ciSummary(...parts: string[]): string {
  return (
    parts.length +
    " pull request" +
    (parts.length === 1 ? "" : "s") +
    " with CI: " +
    parts.join("; ")
  );
}

function pullRequest(number: number, checks: Checks): ControlUiSessionPullRequest {
  return {
    owner: "openclaw",
    repo: "openclaw",
    number,
    branch: `feature/pr-${number}`,
    title: `Repair the widget path ${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    state: "open",
    headSha,
    additions: 4,
    deletions: 3,
    checks,
    checksUrl: `https://github.com/openclaw/openclaw/pull/${number}/checks`,
  };
}

const suite = createControlUiE2eSuite({
  name: "chat pull request live region",
  trackBrowserContexts: true,
});

async function setup() {
  const context = await suite.newBrowserContext({
    viewport: { width: 1180, height: 900 },
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    sessionKey,
    sessions: [{ key: sessionKey, sessionId, label: "PR review", kind: "direct", updatedAt: 1 }],
    featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
    historyMessages: [
      { role: "assistant", content: "The branch is ready for review.", timestamp: 1 },
    ],
    methodResponses: { [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true } },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const watchedKey = await waitForWatchedSessionKey(gateway);
  // With the details panel enabled the pull request list renders there rather than inline in
  // the transcript.
  await openChatDetails(page);
  async function publish(rows: ControlUiSessionPullRequest[]) {
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [watchedKey]: { pullRequests: rows, rateLimited: false, status: "ready" } },
    });
    await page.locator(".chat-prs").first().waitFor();
  }
  return { page, publish };
}

/** Normalized text of every polite live region on the chat surface, in DOM order. */
async function regionTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-live="polite"]')).map((region) =>
      (region.textContent ?? "").replace(/\s+/g, " ").trim(),
    ),
  );
}

/** The two regions that belong to this list: the row count, then the CI summary. */
async function listRegions(page: Page): Promise<{ count: string; ci: string }> {
  const texts = await regionTexts(page);
  return {
    count: texts.find((text) => /^\d+ pull requests?$/.test(text)) ?? "",
    ci: texts.find((text) => text.includes("with CI:")) ?? "",
  };
}

type Trace = { count: number; ci: number };

/**
 * Counts live-region mutations inside the page, per region. This is the measurement the review
 * asked for: whether a poll actually mutates each announced region, rather than inferring it from
 * rendered text.
 */
async function installTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const traced = window as unknown as { prLiveTrace?: { count: number; ci: number } };
    traced.prLiveTrace = { count: 0, ci: 0 };
    for (const region of Array.from(document.querySelectorAll('[aria-live="polite"]'))) {
      const text = (region.textContent ?? "").replace(/\s+/g, " ").trim();
      const key = text.includes("with CI:")
        ? "ci"
        : /^\d+ pull requests?$/.test(text)
          ? "count"
          : null;
      if (!key) {
        continue;
      }
      new MutationObserver((batch) => {
        const target = traced.prLiveTrace;
        if (target) {
          target[key] += batch.length;
        }
      }).observe(region, { childList: true, characterData: true, subtree: true });
    }
  });
}

async function readTrace(page: Page): Promise<Trace> {
  return page.evaluate(
    () => (window as unknown as { prLiveTrace?: Trace }).prLiveTrace ?? { count: 0, ci: 0 },
  );
}

async function resetTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const traced = window as unknown as { prLiveTrace?: Trace };
    if (traced.prLiveTrace) {
      traced.prLiveTrace = { count: 0, ci: 0 };
    }
  });
}

/** The polite live regions Chromium reports, for the accessibility trace. */
async function politeRegions(page: Page): Promise<Array<{ role: string; name: string }>> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Accessibility.enable");
    const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
      nodes: Array<{
        ignored?: boolean;
        role?: { value?: string };
        name?: { value?: string };
        properties?: Array<{ name: string; value?: { value?: unknown } }>;
      }>;
    };
    return nodes
      .filter(
        (node) =>
          !node.ignored &&
          node.properties?.some(
            (property) => property.name === "live" && property.value?.value === "polite",
          ),
      )
      .map((node) => ({
        role: node.role?.value ?? "",
        name: (node.name?.value ?? "").replace(/\s+/g, " ").trim(),
      }));
  } finally {
    await session.detach();
  }
}

suite.define(() => {
  it("announces per-PR CI changes without repeating identical polling snapshots", async () => {
    const { page, publish } = await setup();
    const steps: Array<{ step: string; count: number; ci: number }> = [];

    await publish([pullRequest(101, running), pullRequest(102, running)]);
    await expect.poll(async () => (await listRegions(page)).count).toBe("2 pull requests");
    expect((await listRegions(page)).ci).toBe(ciSummary(running101, running102));
    expect(await page.locator(".chat-prs a").count()).toBeGreaterThanOrEqual(2);

    // Neither region carries interactive content.
    for (const selector of ['[aria-live="polite"]']) {
      const interactive = await page.locator(selector).locator("a, button").count();
      expect(interactive).toBe(0);
    }

    // Chromium's accessibility tree exposes a polite live region for this surface.
    expect((await politeRegions(page)).some((region) => region.role === "status")).toBe(true);

    await installTrace(page);

    // 1. Identical poll: the same snapshot re-sent. Neither region may mutate.
    const before = await listRegions(page);
    const rowsBefore = await page.locator(".chat-prs").innerHTML();
    await resetTrace(page);
    await publish([pullRequest(101, running), pullRequest(102, running)]);
    expect(await listRegions(page)).toEqual(before);
    expect(await page.locator(".chat-prs").innerHTML()).toBe(rowsBefore);
    let trace = await readTrace(page);
    steps.push({ step: "identical poll", ...trace });
    expect(trace).toEqual({ count: 0, ci: 0 });

    // Progress within one pending PR must not disappear behind unchanged PR-state buckets.
    await resetTrace(page);
    await publish([pullRequest(101, progressed), pullRequest(102, running)]);
    await expect
      .poll(async () => (await listRegions(page)).ci)
      .toBe(ciSummary(progressed101, running102));
    const progressTrace = await readTrace(page);
    steps.push({ step: "check progress while pending", ...progressTrace });
    expect(progressTrace.count).toBe(0);
    expect(progressTrace.ci).toBeGreaterThan(0);

    // 2. Mixed state: one row starts failing while the other keeps running.
    await resetTrace(page);
    await publish([pullRequest(101, failing), pullRequest(102, running)]);
    await expect
      .poll(async () => (await listRegions(page)).ci)
      .toBe(ciSummary(failing101, running102));
    trace = await readTrace(page);
    steps.push({ step: "running -> failing (mixed)", ...trace });
    expect(trace.count).toBe(0);
    expect(trace.ci).toBeGreaterThan(0);

    // 3. The row that was masked before: it finishes while another row stays failing, so the
    //    failing count never changes, but the other PR still needs its completion announced.
    await resetTrace(page);
    await publish([pullRequest(101, failing), pullRequest(102, passing)]);
    await expect
      .poll(async () => (await listRegions(page)).ci)
      .toBe(ciSummary(failing101, passing102));
    trace = await readTrace(page);
    steps.push({ step: "running -> passed beside a failure", ...trace });
    expect(trace.count).toBe(0);
    expect(trace.ci).toBeGreaterThan(0);

    // Equal aggregate counts must not conceal two PRs exchanging failed/passed states.
    await resetTrace(page);
    await publish([pullRequest(101, passing), pullRequest(102, failing)]);
    await expect
      .poll(async () => (await listRegions(page)).ci)
      .toBe(ciSummary(passing101, failing102));
    trace = await readTrace(page);
    steps.push({ step: "PRs exchange failing and passing states", ...trace });
    expect(trace.count).toBe(0);
    expect(trace.ci).toBeGreaterThan(0);

    // 4. Every row settles: completion is announced, not produced by clearing the region.
    await resetTrace(page);
    await publish([pullRequest(101, passing), pullRequest(102, passing)]);
    await expect
      .poll(async () => (await listRegions(page)).ci)
      .toBe(ciSummary(passing101, passing102));
    trace = await readTrace(page);
    steps.push({ step: "failing -> passed", ...trace });
    expect(trace.count).toBe(0);
    expect(trace.ci).toBeGreaterThan(0);

    // 5. A row disappears: both regions report it.
    await resetTrace(page);
    await publish([pullRequest(101, passing)]);
    await expect.poll(async () => (await listRegions(page)).count).toBe("1 pull request");
    await expect.poll(async () => (await listRegions(page)).ci).toBe(ciSummary(passing101));
    trace = await readTrace(page);
    steps.push({ step: "row removed", ...trace });
    expect(trace.count).toBeGreaterThan(0);
    expect(trace.ci).toBeGreaterThan(0);

    // The trace is the evidence artifact for this run.
    for (const entry of steps) {
      console.log(
        `[pr-live-region] ${entry.step}: count-region=${entry.count} ci-region=${entry.ci}`,
      );
    }
  });
});
