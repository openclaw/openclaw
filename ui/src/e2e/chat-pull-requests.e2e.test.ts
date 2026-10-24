import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserContextOptions, Locator } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiSessionPullRequest,
} from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import {
  closeChatDetails,
  openChatDetails,
  openChatPublication,
  openDetailsPullRequests,
} from "./chat-details.test-support.ts";
import {
  sharedPublisher,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session pull request chips",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
function newBrowserContext(options: BrowserContextOptions = {}) {
  return suite.newBrowserContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
    ...options,
  });
}

const subscriptionResponses = { [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true } };
const subscriptionMethods = [
  "chat.metadata",
  "chat.startup",
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
];
const terminalFailure = {
  requestId: "publication-failed",
  publisher: sharedPublisher,
  status: "failed",
  code: "push_rejected",
  message: "GitHub publication failed.",
  nextAction: "Check repository write access and retry.",
};

function pullRequest(
  number: number,
  fields: Partial<ControlUiSessionPullRequest> = {},
): ControlUiSessionPullRequest {
  return {
    number,
    owner: "openclaw",
    repo: "openclaw",
    branch: "fix/example",
    title: `Example ${number}`,
    url: `https://github.com/openclaw/openclaw/pull/${number}`,
    state: "merged",
    ...fields,
  };
}

function publicationState(
  branch: string,
  details: { additions?: number; deletions?: number; createUrl?: string } = {},
) {
  return {
    pullRequests: [],
    branch: { owner: "openclaw", repo: "openclaw", branch, additions: 2, deletions: 1, ...details },
    rateLimited: false,
    status: "ok",
  };
}

async function openPublicationChat(
  methodResponses: Record<string, unknown> = {},
  scenario: ControlUiMockGatewayScenario = {},
  options: BrowserContextOptions = {},
) {
  const context = await newBrowserContext(options);
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods: [...subscriptionMethods, "sessions.github.publish", "sessions.github.options"],
    ...scenario,
    methodResponses: { ...subscriptionResponses, ...methodResponses },
  });
  await page.goto(
    scenario.sessionKey
      ? controlUiSessionUrl(suite.server.baseUrl, scenario.sessionKey)
      : `${suite.server.baseUrl}chat`,
  );
  const watchedKey = await waitForWatchedSessionKey(gateway);
  await openChatDetails(page);
  return { page, gateway, watchedKey };
}

function emitPullRequests(gateway: MockGatewayControls, key: string, snapshot: unknown) {
  return gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: { [key]: snapshot },
  });
}

const pollText = (item: Locator) => expect.poll(() => item.textContent());
const pollCount = (item: Locator) => expect.poll(() => item.count());
const pollAttr = (item: Locator, name: string) => expect.poll(() => item.getAttribute(name));

function publicationRequestKey(params: unknown): string {
  const key = asNullableRecord(params)?.idempotencyKey;
  if (typeof key !== "string") {
    throw new Error("Expected publication request to carry an idempotency key");
  }
  return key;
}

suite.define(() => {
  it("shows mobile publication only for an eligible branch or retained attempt", async () => {
    const { page, gateway, watchedKey } = await openPublicationChat(
      { "sessions.github.publish": terminalFailure },
      {},
      { viewport: { width: 393, height: 852 } },
    );
    await closeChatDetails(page);
    await gateway.waitForRequest("sessions.github.options");
    const pill = page.locator('.activity-pill[data-family="publication"]');
    const empty = { pullRequests: [], rateLimited: false, status: "ready" };
    await emitPullRequests(gateway, watchedKey, empty);
    await pollCount(pill).toBe(0);

    // Branch discovery already establishes publishable work, including binary-only
    // changes whose text addition/deletion counts are zero or unavailable.
    await emitPullRequests(
      gateway,
      watchedKey,
      publicationState("openclaw/ready", {
        additions: 0,
        deletions: 0,
      }),
    );
    await pollCount(pill).toBe(1);
    await emitPullRequests(gateway, watchedKey, empty);
    await pollCount(pill).toBe(0);

    await emitPullRequests(gateway, watchedKey, publicationState("openclaw/ready"));
    await pill.click();
    await page.getByRole("button", { name: "Publish PR", exact: true }).click();
    await pollCount(page.locator('.chat-pr__publication-outcome[data-state="failed"]')).toBe(1);
    await closeChatDetails(page);
    await emitPullRequests(gateway, watchedKey, empty);
    await pollText(pill).toContain("Publish failed");
  });

  it("shows detected PRs in Details with rate-limit staleness", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: subscriptionMethods,
      methodResponses: subscriptionResponses,
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const watchedKey = await waitForWatchedSessionKey(gateway);
    await emitPullRequests(gateway, watchedKey, {
      pullRequests: [
        pullRequest(103469, {
          branch: "claude/browser-tabs-tighter-header",
          title: "fix(macos): tighten the link-browser tab header",
          state: "open",
          additions: 4,
          deletions: 3,
          checks: { state: "passing", passed: 65, failed: 0, skipped: 31, running: 0 },
          checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
        }),
        pullRequest(103438, {
          branch: "claude/browser-tabs-web-ui-756a64",
        }),
        pullRequest(103200, {
          branch: "claude/browser-tabs-web-ui-756a64",
        }),
      ],
      rateLimited: true,
      status: "rate-limited",
    });

    const chips = page.locator(".chat-pr");
    expect(await page.locator(".chat-details-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(await chips.count()).toBe(0);
    await openDetailsPullRequests(page);
    await pollCount(chips).toBe(3);
    expect(
      await page.locator('[data-details-group="pull-requests"]').getAttribute("open"),
    ).not.toBeNull();
    const openChip = chips.first();
    await pollAttr(openChip, "data-state").toBe("open");
    await pollText(openChip.locator(".chat-pr__title")).toBe(
      "fix(macos): tighten the link-browser tab header",
    );
    await pollAttr(openChip.locator(".chat-pr__link"), "href").toBe(
      "https://github.com/openclaw/openclaw/pull/103469",
    );
    const actions = openChip.locator(".chat-pr__actions-trigger");
    await actions.click();
    const menu = page.locator(".chat-pr-menu").filter({ visible: true });
    await pollText(menu.locator(".chat-pr-menu__repository")).toContain("openclaw/openclaw");
    await pollText(menu.locator(".chat-pr-menu__repository")).toContain("#103469");
    await pollText(menu.locator(".chat-pr__additions")).toBe("+4");
    await pollCount(menu.locator(".chat-pr__stale")).toBe(1);
    await menu.getByRole("menuitem", { name: "Checks: Passed 65", exact: true }).click();
    await pollText(menu.locator(".chat-pr__checks-row--passed")).toContain("65");
    await pollText(menu.locator(".chat-pr__checks-row--skipped")).toContain("31");
    await pollAttr(menu.getByRole("menuitem", { name: "Open checks on GitHub" }), "href").toBe(
      "https://github.com/openclaw/openclaw/pull/103469/checks",
    );
    await page.locator(".agent-chat__input textarea").click();
    await expect.poll(() => menu.isVisible()).toBe(false);
    await openChatDetails(page);
    expect(await menu.isVisible()).toBe(false);
    await actions.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => menu.isVisible()).toBe(true);
    await menu.getByRole("menuitem", { name: "Checks: Passed 65", exact: true }).click();
    await page.keyboard.press("Escape");
    await menu.getByRole("menuitem", { name: "Checks: Passed 65", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => menu.isVisible()).toBe(false);

    const mergedChip = chips.nth(1);
    await pollAttr(mergedChip, "data-state").toBe("merged");
    await mergedChip.locator(".chat-pr__actions-trigger").click();
    await pollText(menu.locator(".chat-pr-menu__facts")).toContain("Merged");
    await pollCount(menu.locator(".chat-pr__stale")).toBe(0);
    await page.keyboard.press("Escape");

    await page.locator(".chat").evaluate(finishElementAnimations);
    expect(await page.locator(".chat-footer .chat-prs").count()).toBe(0);
    expect(await page.locator(".chat-details .chat-pr").count()).toBe(3);
    const detailsBox = await page.locator('.chat-details[role="dialog"]').boundingBox();
    const composerBox = await page.locator(".agent-chat__input").boundingBox();
    expect(detailsBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(composerBox!.y);

    await mergedChip
      .getByRole("button", {
        name: "Actions for pull request openclaw/openclaw#103438",
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: "Hide", exact: true }).click();
    await pollCount(chips).toBe(2);
    await pollAttr(chips.first().locator(".chat-pr__link"), "href").toContain("/103469");
  });

  it.each([
    { width: 1440, theme: "light" },
    { width: 1440, theme: "dark" },
    { width: 390, theme: "light" },
    { width: 390, theme: "dark" },
  ] as const)(
    "keeps every PR visible and actionable at $width in $theme",
    async ({ width, theme }) => {
      const context = await newBrowserContext();
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        ({ key, mode }) => {
          localStorage.setItem(key, JSON.stringify({ themeMode: mode }));
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: theme },
      );
      const gateway = await installMockGateway(page, {
        featureMethods: subscriptionMethods,
        historyMessages: [{ role: "assistant", content: "The changes are ready to inspect." }],
        methodResponses: subscriptionResponses,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const watchedKey = await waitForWatchedSessionKey(gateway);
      await openChatDetails(page);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe(theme);
      const mobile = width < 768;
      const stack = mobile
        ? page.locator(
            '.chat-mobile-details-page[data-details-page="root"]:visible [data-details-group="pull-requests"] .chat-details-mobile-root__group',
          )
        : page.locator(".chat-prs");
      const chips = stack.locator(mobile ? ".chat-pr-mobile__row" : ".chat-pr");
      for (const count of [1, 2, 3]) {
        await emitPullRequests(gateway, watchedKey, {
          pullRequests: Array.from({ length: count }, (_, index) => pullRequest(index + 1)),
          rateLimited: false,
          status: "ready",
        });
        await openDetailsPullRequests(page);
        await pollCount(chips).toBe(count);
        await page.locator(".chat").evaluate(finishElementAnimations);
        const bounds = await stack.evaluate((element) => {
          const detailsBounds = element
            .closest(".chat-mobile-host, .chat-details")!
            .getBoundingClientRect();
          const stackBounds = element.getBoundingClientRect();
          return {
            detailsBottom: detailsBounds.bottom,
            stackLeft: stackBounds.left,
            stackWidth: stackBounds.width,
            fitsHorizontally: element.scrollWidth <= element.clientWidth + 1,
            rows: [...element.children].map((row) => {
              const rect = row.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
            }),
          };
        });
        expect(bounds.fitsHorizontally).toBe(true);
        let previousBottom = 0;
        for (const row of bounds.rows) {
          expect(row.top).toBeGreaterThanOrEqual(previousBottom);
          expect(row.bottom).toBeLessThanOrEqual(bounds.detailsBottom);
          expect(row.left).toBeCloseTo(bounds.stackLeft, 1);
          expect(row.width).toBeCloseTo(bounds.stackWidth, 1);
          previousBottom = row.bottom;
        }
        for (let index = 0; index < count; index++) {
          const chip = chips.nth(index);
          const expectedUrl = `https://github.com/openclaw/openclaw/pull/${index + 1}`;
          if (mobile) {
            await chip.click();
            const detail = page.locator(
              '.chat-mobile-details-page[data-details-page="pull-request"]:visible',
            );
            const link = detail.getByRole("link", { name: "Open on GitHub", exact: true });
            await pollAttr(link, "href").toBe(expectedUrl);
            await link.click({ trial: true });
            await detail.getByRole("button", { name: "Hide", exact: true }).click({ trial: true });
            await openDetailsPullRequests(page);
          } else {
            await pollAttr(chip.locator(".chat-pr__link"), "href").toBe(expectedUrl);
            await chip.locator(".chat-pr__link").click({ trial: true });
            await chip
              .getByRole("button", {
                name: `Actions for pull request openclaw/openclaw#${index + 1}`,
                exact: true,
              })
              .click();
            const menu = chip.getByRole("menu");
            await menu.getByRole("menuitem", { name: "Hide", exact: true }).click({ trial: true });
            await page.keyboard.press("Escape");
            await menu.waitFor({ state: "hidden" });
          }
        }
      }
      if (mobile) {
        await closeChatDetails(page);
        await page.locator('.activity-pill[data-family="pull-request"]').first().click();
        await page
          .locator('.chat-mobile-details-page[data-details-page="pull-request"]:visible')
          .waitFor();
        expect(
          await page
            .locator(".chat-mobile-host__header")
            .getByRole("button", { name: "Back", exact: true })
            .count(),
        ).toBe(0);
        await openDetailsPullRequests(page);
        await pollCount(chips).toBe(3);
      }
    },
  );

  it.each([
    { label: "desktop", viewport: { width: 1180, height: 800 } },
    { label: "mobile", viewport: { width: 393, height: 852 } },
  ])(
    "offers a compact publication row while rate limited on $label",
    async ({ label, viewport }) => {
      const { page, gateway, watchedKey } = await openPublicationChat(
        {},
        {},
        { viewport: { width: 1180, height: 800 } },
      );
      await emitPullRequests(gateway, watchedKey, {
        pullRequests: [],
        branch: {
          owner: "openclaw",
          repo: "openclaw",
          branch: "claude/cloud-workers-live-events",
          additions: 2819,
          deletions: 205,
          createUrl:
            "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
        },
        rateLimited: true,
        status: "rate-limited",
      });

      const mobile = label === "mobile";
      if (mobile) {
        const desktop = await openChatPublication(page);
        await pollText(
          desktop.locator(".chat-environment__branch .chat-environment__branch-name"),
        ).toBe("claude/cloud-workers-live-events");
        await page.setViewportSize(viewport);
      }
      const publication = await openChatPublication(page);
      const row = publication.locator(
        mobile ? ".github-publication-mobile" : ".chat-environment__branch",
      );
      await pollCount(row).toBe(1);
      await pollText(
        row.locator(
          mobile ? ".github-publication-mobile__branch" : ".chat-environment__branch-name",
        ),
      ).toBe("claude/cloud-workers-live-events");
      await pollText(row.locator(".chat-pr__additions")).toBe("+2,819");
      await pollText(row.locator(".chat-pr__deletions")).toBe("−205");
      if (mobile) {
        const group = await openDetailsPullRequests(page);
        await expect
          .poll(() => group.locator(".chat-pr-mobile__recovery").textContent())
          .toContain("Couldn’t update");
        await openChatPublication(page);
      } else {
        await pollCount(row.locator(".chat-pr__warning")).toBe(1);
      }
      const create = row.getByRole("button", {
        name: mobile ? "Publish PR" : "Create PR",
        exact: true,
      });
      await pollText(create).toContain(mobile ? "Publish PR" : "Create PR");
      await pollAttr(create, "href").toBeNull();
      const dismiss = publication.getByRole("button", {
        name: "Hide claude/cloud-workers-live-events for this session",
        exact: true,
      });
      await page.locator(".chat").evaluate(finishElementAnimations);
      await expect
        .poll(async () => {
          const rowBox = await row.boundingBox();
          const detailsBox = await page
            .locator(mobile ? ".chat-mobile-host" : '.chat-details[role="dialog"]')
            .filter({ visible: true })
            .boundingBox();
          return Boolean(
            rowBox &&
            detailsBox &&
            rowBox.x >= detailsBox.x &&
            rowBox.x + rowBox.width <= detailsBox.x + detailsBox.width &&
            detailsBox.x >= 0 &&
            detailsBox.x + detailsBox.width <= viewport.width &&
            (await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)),
          );
        })
        .toBe(true);
      await create.click({ trial: true });

      await dismiss.click();
      if (mobile) {
        await pollCount(row).toBe(0);
      } else {
        await pollCount(row.locator(".chat-pr__publication-actions")).toBe(0);
        await pollText(row.locator(".chat-environment__branch-name")).toBe(
          "claude/cloud-workers-live-events",
        );
      }
    },
  );

  it("publishes through the Gateway and renders the terminal pull request URL", async () => {
    const { page, gateway, watchedKey } = await openPublicationChat();
    await emitPullRequests(
      gateway,
      watchedKey,
      publicationState("openclaw/reconciled-publication", {
        additions: 42,
        deletions: 7,
      }),
    );

    await openChatPublication(page);
    await gateway.deferNext("sessions.github.publish");
    const publish = page.getByRole("button", { name: "Create PR" });
    await publish.waitFor();
    await publish.click();
    const request = await gateway.waitForRequest("sessions.github.publish");
    expect(request.params).toMatchObject({
      sessionKey: "agent:main:main",
      selection: { source: "shared", expected: sharedPublisher },
    });
    await pollText(page.locator("[data-publication-account]")).toContain("Publish as @system-bot");
    await pollCount(page.getByRole("button", { name: "Publication account", exact: true })).toBe(0);
    expect(request.params).not.toHaveProperty("title");
    expect(JSON.stringify(request.params)).not.toContain("token");
    expect(request.params).not.toHaveProperty("repository");
    // Admission moves the action into a menu that can close during the handoff.
    await openChatPublication(page);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".chat-pr-branch-menu").isVisible()).toBe(false);
    await openChatPublication(page);
    await expect
      .poll(() => page.getByRole("button", { name: "Publishing…" }).isDisabled())
      .toBe(true);

    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "publication-1",
      publisher: sharedPublisher,
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125200",
      repository: "openclaw/openclaw",
      branch: "openclaw/reconciled-publication",
      headCommit: "a".repeat(40),
    });
    const publishedGroup = await openDetailsPullRequests(page);
    const open = publishedGroup.getByRole("link", { name: "Open PR" });
    await open.waitFor();
    await pollAttr(open, "href").toBe("https://github.com/openclaw/openclaw/pull/125200");
    const environment = page.locator(".chat-environment__branch");
    expect(await environment.locator(".chat-pr__diff, .chat-pr__publication-actions").count()).toBe(
      0,
    );
    expect(await environment.getByRole("link", { name: "Open PR" }).count()).toBe(0);
    expect(await environment.locator(".chat-environment__branch-name").textContent()).toBe(
      "openclaw/reconciled-publication",
    );

    await emitPullRequests(gateway, watchedKey, {
      pullRequests: [
        pullRequest(125200, {
          branch: "openclaw/reconciled-publication",
          state: "open",
        }),
      ],
      branch: {
        owner: "openclaw",
        repo: "openclaw",
        branch: "openclaw/reconciled-publication",
        additions: 3,
        deletions: 0,
        createUrl: "https://github.com/openclaw/openclaw/pull/new/openclaw/reconciled-publication",
      },
      rateLimited: false,
      status: "ok",
    });
    await openDetailsPullRequests(page);
    await pollCount(
      publishedGroup.locator(
        'a.chat-pr__link[href="https://github.com/openclaw/openclaw/pull/125200"]',
      ),
    ).toBe(1);
    expect(await environment.locator(".chat-pr__diff, .chat-pr__publication-actions").count()).toBe(
      0,
    );
    await pollCount(page.getByRole("button", { name: "Create PR" })).toBe(0);
    await pollCount(page.getByRole("link", { name: "Open PR" })).toBe(0);

    // Once that PR is merged, remaining branch changes are a new publication opportunity.
    await emitPullRequests(gateway, watchedKey, {
      pullRequests: [
        pullRequest(125200, {
          branch: "openclaw/reconciled-publication",
          state: "merged",
        }),
      ],
      branch: {
        owner: "openclaw",
        repo: "openclaw",
        branch: "openclaw/reconciled-publication",
        additions: 3,
        deletions: 0,
        createUrl: "https://github.com/openclaw/openclaw/pull/new/openclaw/reconciled-publication",
      },
      rateLimited: false,
      status: "ok",
    });
    await openChatPublication(page);
    await pollCount(environment.getByRole("button", { name: "Create PR", exact: true })).toBe(1);
    await pollText(environment.locator(".chat-pr__diff")).toContain("+3");
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
  });

  it("drops a deferred publication result after switching to another publishing session", async () => {
    const sessionA = "agent:main:publication-a";
    const sessionB = "agent:main:publication-b";
    const { page, gateway } = await openPublicationChat(
      {
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            { key: sessionA, kind: "direct", label: "Publication A", updatedAt: 2 },
            { key: sessionB, kind: "direct", label: "Publication B", updatedAt: 1 },
          ],
          ts: 1,
        },
      },
      { sessionKey: sessionA },
    );
    await emitPullRequests(gateway, sessionA, publicationState("openclaw/publication-a"));

    await openChatPublication(page);
    await gateway.deferNext("sessions.github.publish", { sessionKey: sessionA });
    const requestCountA = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Create PR" }).click();
    const requestA = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCountA,
    });
    expect(requestA.params).toMatchObject({ sessionKey: sessionA });

    await navigateToControlUiSession(page, sessionB);
    await expect
      .poll(async () => {
        const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        return requests.some((request) => {
          const keys = (request.params as { sessionKeys?: unknown } | undefined)?.sessionKeys;
          return Array.isArray(keys) && keys.includes(sessionB);
        });
      })
      .toBe(true);
    await emitPullRequests(gateway, sessionB, publicationState("openclaw/publication-b"));
    await openChatDetails(page);
    await openChatPublication(page);
    await gateway.deferNext("sessions.github.publish", { sessionKey: sessionB });
    const requestCountB = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Create PR" }).click();
    const requestB = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCountB,
    });
    expect(requestB.params).toMatchObject({ sessionKey: sessionB });
    const publishingB = page.getByRole("button", { name: "Publishing…" });
    const publishingBState = () =>
      publishingB.evaluateAll((buttons) => ({
        count: buttons.length,
        disabled: buttons.map((button) => button.matches(":disabled")),
      }));
    await expect.poll(publishingBState).toEqual({ count: 1, disabled: [true] });

    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "publication-a",
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125301",
      repository: "openclaw/openclaw",
      branch: "openclaw/publication-a",
      headCommit: "a".repeat(40),
    });
    await openChatPublication(page);
    await expect.poll(publishingBState).toEqual({ count: 1, disabled: [true] });
    expect(
      await page.locator('a[href="https://github.com/openclaw/openclaw/pull/125301"]').count(),
    ).toBe(0);
    expect(await page.locator('.chat-pr__publication-outcome[data-state="failed"]').count()).toBe(
      0,
    );

    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "publication-b",
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125302",
      repository: "openclaw/openclaw",
      branch: "openclaw/publication-b",
      headCommit: "b".repeat(40),
    });
    await pollAttr(page.getByRole("link", { name: "Open PR" }), "href").toBe(
      "https://github.com/openclaw/openclaw/pull/125302",
    );
  });

  it("renders a typed publication failure and its next action", async () => {
    const { page, gateway, watchedKey } = await openPublicationChat({
      "sessions.github.publish": terminalFailure,
    });
    await emitPullRequests(
      gateway,
      watchedKey,
      publicationState("openclaw/rejected-publication", {
        createUrl: "https://github.com/openclaw/openclaw/pull/new/openclaw/rejected-publication",
      }),
    );

    await openChatPublication(page);
    await page.getByRole("button", { name: "Create PR" }).click();
    await openChatPublication(page);
    const failure = page.locator('.chat-pr__publication-outcome[data-state="failed"]');
    await pollText(failure).toContain("Publication failed");
    await pollText(failure).toContain("Check repository write access");
    await pollCount(page.getByRole("button", { name: "Choose a new publication" })).toBe(1);
    await pollText(page.locator("[data-publication-account]")).toContain("Publish as @system-bot");
    expect(
      await page
        .locator(
          'a[href="https://github.com/openclaw/openclaw/pull/new/openclaw/rejected-publication"]',
        )
        .count(),
    ).toBe(0);
  });

  it("reuses the publication key after an unknown outcome and rotates it after failure", async () => {
    const { page, gateway, watchedKey } = await openPublicationChat({
      "sessions.github.publish": terminalFailure,
    });
    await emitPullRequests(gateway, watchedKey, publicationState("openclaw/retry-publication"));

    await openChatPublication(page);
    await gateway.deferNext("sessions.github.publish");
    let requestCount = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Create PR" }).click();
    const first = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCount,
    });
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Publication response was lost.",
    });
    await openChatPublication(page);
    await pollCount(page.getByRole("button", { name: "Retry publication" })).toBe(1);

    requestCount = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Retry publication" }).click();
    const second = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCount,
    });
    expect(publicationRequestKey(second.params)).toBe(publicationRequestKey(first.params));
    await pollCount(page.getByRole("button", { name: "Choose a new publication" })).toBe(1);

    requestCount = (await gateway.getRequests("sessions.github.publish")).length;
    await page.getByRole("button", { name: "Choose a new publication" }).click();
    await page.getByRole("button", { name: "Create PR" }).click();
    const third = await gateway.waitForRequest("sessions.github.publish", {
      after: requestCount,
    });
    expect(publicationRequestKey(third.params)).not.toBe(publicationRequestKey(second.params));
  });

  it("preserves explicit shared publication on a cloud-idle workspace", async () => {
    const { page, gateway, watchedKey } = await openPublicationChat({
      "sessions.github.publish": {
        requestId: "cloud-publication",
        status: "requested",
        publisher: sharedPublisher,
        message: "Publication requested after workspace reconciliation.",
      },
      "sessions.list": {
        count: 1,
        defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
        path: "",
        sessions: [
          {
            contextTokens: null,
            hasActiveRun: false,
            key: "main",
            kind: "direct",
            placement: { state: "active" },
            status: "done",
            totalTokens: 0,
            updatedAt: 1,
          },
        ],
        ts: 1,
      },
    });
    await emitPullRequests(gateway, watchedKey, publicationState("openclaw/cloud-idle"));

    await openChatPublication(page);
    await expect.poll(() => page.getByRole("button", { name: "Create PR" }).isEnabled()).toBe(true);
    expect(
      await page.getByRole("button", { name: "Publication account", exact: true }).count(),
    ).toBe(0);
    expect(await page.locator(".chat-pr__accounts-panel").count()).toBe(0);
    expect(await page.locator(".chat-environment__branch").textContent()).not.toContain(
      "reclaim the workspace",
    );
    await page.getByRole("button", { name: "Create PR" }).click();
    const request = await gateway.waitForRequest("sessions.github.publish");
    expect(request.params).toMatchObject({
      selection: { source: "shared", expected: sharedPublisher },
    });
    await pollText(page.locator(".chat-pr__publication-outcome")).toContain(
      "Publication requested after workspace reconciliation.",
    );
  });
});
