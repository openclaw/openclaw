import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import type { ControlUiMockPresenceUser } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionPath,
  controlUiSessionUrl,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openDetailsPullRequests } from "./chat-details.test-support.ts";
import {
  defineGitHubPublicationAccountTests,
  installPublicationGateway,
  publicationAction,
  publicationScreenshot,
  selectPublicationAccount,
} from "./chat-github-publication-accounts.test-support.ts";
import {
  personalAccount,
  personalGeneration,
  publicationOptions,
  sharedPublisher,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Control UI personal GitHub publication" });

function viewer(id: string, name: string): ControlUiMockPresenceUser[] {
  return [{ self: true, id, identity: { type: "profile", id }, name }];
}

function confirmationFixture(repository: string, pushRepository: string, branch: string) {
  return {
    requestDigest: "a".repeat(64),
    generation: personalGeneration,
    account: personalAccount,
    repository,
    pushRepository,
    baseBranch: "main",
    branch,
    sourceHeadCommit: "1".repeat(40),
    sourceIndexTree: "2".repeat(40),
    workspaceTree: "3".repeat(40),
  };
}

function publicationContextOptions(): Parameters<typeof suite.newBrowserContext>[0] {
  return {
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
    ...(captureUiProof
      ? { recordVideo: { dir: suite.artifactDir, size: { width: 1180, height: 800 } } }
      : {}),
  };
}

async function newPublicationContext() {
  return await suite.newBrowserContext(publicationContextOptions());
}

suite.define(() => {
  it.each(["global", "per-sender"] as const)(
    "carries the selected agent through the complete %s publication flow",
    async (scope) => {
      await suite.withPage(publicationContextOptions(), async ({ page }) => {
        const screenshot = async (name: string) => {
          if (captureUiProof) {
            await page.screenshot({ path: path.join(suite.artifactDir, name), fullPage: true });
          }
        };
        const sessionKey = scope === "global" ? "global" : "agent:research:main";
        const target = { sessionKey, agentId: "research" };
        const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b6";
        const row = createControlUiSessionRow(sessionKey, "Research publication", 1, {
          kind: scope === "global" ? "global" : "direct",
        });
        const result = {
          requestId,
          status: "needs_confirmation",
          publisher: { source: "personal", ...personalAccount },
          message: "Review the selected research session before continuing.",
        };
        const confirmation = confirmationFixture(
          "synthetic/publication-demo",
          "alice-tools/publication-demo",
          "feature/research",
        );
        const gateway = await installPublicationGateway(page, {
          defaultAgentId: "ops",
          assistantAgentId: "research",
          assistantName: "Research QA",
          workspace: "/synthetic/research",
          communityInvite: false,
          sessionKey,
          sessionScope: scope === "global" ? "global" : "per-sender",
          sessions: [row],
          presenceUsers: viewer("synthetic", "Synthetic reviewer"),
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "ops", name: "Operations" },
                { id: "research", name: "Research QA" },
              ],
              defaultId: "ops",
              mainKey: "main",
              scope: scope === "global" ? "global" : "per-sender",
            },
            "sessions.list": {
              ts: 1,
              path: "",
              count: 1,
              agentId: "research",
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [row],
            },
            "sessions.github.publish": result,
            "sessions.github.status": { result, confirmation },
            "sessions.github.confirm": {
              requestId,
              status: "published",
              publisher: result.publisher,
              url: "https://github.com/synthetic/publication-demo/pull/42",
              repository: confirmation.repository,
              branch: confirmation.branch,
              headCommit: "4".repeat(40),
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:research:main"));
        await showPublicationBranch(gateway, confirmation.branch);
        await openDetailsPullRequests(page);
        const optionRequest = await gateway.waitForRequest("sessions.github.options");
        expect(optionRequest.params).toEqual(target);
        await selectPublicationAccount(page, "personal");
        await screenshot("01-selected-research.png");
        await publicationAction(page, "Publish PR").click();
        const publication = await gateway.waitForRequest("sessions.github.publish");
        expect(publication.params).toMatchObject({
          ...target,
          selection: {
            source: "personal",
            account: personalAccount,
            generation: personalGeneration,
          },
        });
        const status = await gateway.waitForRequest("sessions.github.status");
        expect(status.params).toEqual({ ...target, requestId });
        const confirm = publicationAction(page, "Confirm original publication");
        await confirm.waitFor();
        await screenshot("02-research-confirmation.png");
        await confirm.click();
        const confirmed = await gateway.waitForRequest("sessions.github.confirm");
        expect(confirmed.params).toEqual({
          ...target,
          requestId,
          generation: personalGeneration,
          account: personalAccount,
          requestDigest: confirmation.requestDigest,
        });
        const openPr = page.getByRole("link", { name: "Open PR", exact: true });
        await openPr.waitFor();
        expect(await openPr.getAttribute("href")).toBe(
          "https://github.com/synthetic/publication-demo/pull/42",
        );
        expect(new URL(page.url()).pathname).toBe("/chat/research");
        await screenshot("03-research-published.png");
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, "selected-owner-rpc.json"),
            JSON.stringify(
              { scope, target, requests: [optionRequest, publication, status, confirmed] },
              null,
              2,
            ),
          );
        }
      });
    },
  );

  it("shares admitted publication state between already-open same-session split panes", async () => {
    const context = await newPublicationContext();
    const sessionKey = "agent:main:publication";
    await context.addInitScript(
      ({ settingsKey, sessionKey: initialSessionKey }) => {
        localStorage.setItem(
          settingsKey,
          JSON.stringify({
            chatSplitLayout: {
              activePaneId: "p1",
              columns: [
                {
                  id: "c1",
                  panes: [{ id: "p1", sessionKey: initialSessionKey }],
                  paneWeights: [1],
                },
                {
                  id: "c2",
                  panes: [{ id: "p2", sessionKey: initialSessionKey }],
                  paneWeights: [1],
                },
              ],
              columnWeights: [0.5, 0.5],
            },
          }),
        );
      },
      { settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
    );
    const page = await context.newPage();
    const gateway = await installPublicationGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      sessionKey,
      sessions: [createControlUiSessionRow(sessionKey, "Publication task", 1)],
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await showPublicationBranch(gateway);
    const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
    await expect.poll(() => panes.count()).toBe(2);
    const first = panes.nth(0);
    const second = panes.nth(1);
    await openDetailsPullRequests(second);
    await publicationScreenshot(suite, page, "split-details-open.png", [
      second.getByRole("dialog", { name: "Details", exact: true }),
    ]);
    await publicationAction(second, "Publish PR").waitFor();
    await openDetailsPullRequests(first);
    await publicationAction(first, "Publish PR").waitFor();
    // Only the focused pane's Details is open. Its sibling must still project the
    // admitted publication state before another user interaction reconciles it.
    expect(await second.locator(".chat-details-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await gateway.deferNext("sessions.github.publish");
    await publicationAction(first, "Publish PR").click();
    const original = await gateway.waitForRequest("sessions.github.publish");
    await publicationAction(first, "Publishing…").waitFor();
    const pendingProjectionError = await expect
      .poll(() =>
        second
          .getByRole("button", { name: "Publishing…", exact: true, includeHidden: true })
          .count(),
      )
      .toBe(1)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect.soft(pendingProjectionError).toBeUndefined();
    await publicationScreenshot(suite, page, "split-publication-pending.png", [first, second]);
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Publication response lost; retry the original request.",
    });
    await publicationAction(first, "Retry publication").waitFor();
    const retryProjectionError = await expect
      .poll(() =>
        second
          .getByRole("button", { name: "Retry publication", exact: true, includeHidden: true })
          .count(),
      )
      .toBe(1)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect.soft(retryProjectionError).toBeUndefined();
    await publicationScreenshot(suite, page, "split-publication-unknown.png", [first, second]);
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
    // Exercise the normal pointer/focus path separately: it may reconcile a
    // stale pane, but it must never create another publication identity.
    await second.click({ position: { x: 20, y: 80 } });
    await openDetailsPullRequests(second);
    const retry = publicationAction(second, "Retry publication");
    await retry.waitFor();
    await gateway.deferNext("sessions.github.publish");
    await retry.click();
    const repeated = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(repeated.params).toEqual(original.params);
  });

  it.each([
    ["shared", "navigating away and back", ["agent:main:other"]],
    ["personal", "navigating away and back", ["agent:main:other"]],
    ["shared", "LRU eviction", ["agent:main:other", "agent:main:third", "agent:main:fourth"]],
  ] as const)("keeps the original %s retry after %s", async (source, navigation, via) => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const sessionA = "agent:main:publication";
    const gateway = await installPublicationGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      sessionKey: sessionA,
      sessions: [
        createControlUiSessionRow(sessionA, "Publication task", 2),
        ...via.map((key, index) =>
          createControlUiSessionRow(key, index === 0 ? "Other task" : `Other task ${index + 1}`, 1),
        ),
      ],
      presenceUsers: viewer("synthetic", "Synthetic reviewer"),
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await showPublicationBranch(gateway, undefined, sessionA);
    await openDetailsPullRequests(page);
    const activePane = page.locator(".chat-pane-cache__pane--active");
    await selectPublicationAccount(activePane, source);
    await gateway.deferNext("sessions.github.publish");
    await publicationAction(activePane, "Publish PR").click();
    const first = await gateway.waitForRequest("sessions.github.publish");
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Publication response lost; retry the original request.",
    });
    const retry = publicationAction(activePane, "Retry publication");
    await retry.waitFor();
    const originalPane = await activePane.elementHandle();
    expect(originalPane).not.toBeNull();
    await publicationScreenshot(suite, page, `${source}-before-navigation.png`, [retry]);
    const sessionLink = (key: string) =>
      page.locator(
        `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
      );
    for (const next of via) {
      await sessionLink(next).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(next));
    }
    await expect
      .poll(() => originalPane!.evaluate((element) => element.isConnected))
      .toBe(navigation !== "LRU eviction");
    await sessionLink(sessionA).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionA));
    await showPublicationBranch(gateway, undefined, sessionA);
    await openDetailsPullRequests(page);
    const publication = activePane.locator('.chat-pr[data-state="branch"]');
    await publication.waitFor();
    await expect
      .poll(() =>
        publication.getByRole("button", { name: /^(Publish PR|Retry publication)$/ }).isEnabled(),
      )
      .toBe(true);
    if (captureUiProof) {
      await writeFile(
        path.join(suite.artifactDir, `${source}-after-navigation.png`),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [publication]),
      );
      if (navigation === "LRU eviction") {
        await writeFile(
          path.join(suite.artifactDir, "eviction-observation.json"),
          JSON.stringify({
            originalPaneConnected: await originalPane!.evaluate((element) => element.isConnected),
            pathname: new URL(page.url()).pathname,
            publishRequests: await gateway.getRequests("sessions.github.publish"),
            retryButtons: await retry.count(),
            newPublicationButtons: await activePane
              .getByRole("button", { name: "Publish PR", exact: true })
              .count(),
          }),
        );
      }
    }
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
    expect(await retry.count()).toBe(1);
    expect(await publicationAction(activePane, "Publication account").count()).toBe(0);
    await gateway.deferNext("sessions.github.publish");
    await retry.click();
    const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(second.params).toEqual(first.params);
  });

  defineGitHubPublicationAccountTests({ suite, newPublicationContext, captureUiProof });

  it.each(["shared", "personal"] as const)(
    "refreshes a rejected first %s selection without replaying or publishing automatically",
    async (source) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      const gateway = await installPublicationGateway(page, {
        assistantName: "Publication QA",
        workspace: "/synthetic/publication-qa",
        communityInvite: false,
        presenceUsers: viewer("synthetic", "Synthetic reviewer"),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway, "fix/publisher-recovery");
      await openDetailsPullRequests(page);
      await selectPublicationAccount(page, source);
      await gateway.deferNext("sessions.github.publish");
      await publicationAction(page, "Publish PR").click();
      const first = await gateway.waitForRequest("sessions.github.publish");
      if (!isRecord(first.params)) {
        throw new Error("Publication parameters were not an object");
      }
      expect(first.params).toEqual({
        sessionKey: "agent:main:main",
        agentId: "main",
        idempotencyKey: expect.any(String),
        selection:
          source === "shared"
            ? { source, expected: sharedPublisher }
            : { source, generation: personalGeneration, account: personalAccount },
      });
      await gateway.rejectDeferred("sessions.github.publish", {
        code: "UNAVAILABLE",
        message: "The selected publisher changed. Refresh and review the current account.",
        details: {
          code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
          idempotencyKey: first.params.idempotencyKey,
        },
      });
      const publish = publicationAction(page, "Publish PR");
      await expect.poll(() => publish.isDisabled()).toBe(true);
      const nextAccount = { accountId: 4, login: "publisher-current" };
      const next = {
        ...publicationOptions,
        shared: { ...sharedPublisher, ...nextAccount },
        personal: {
          ...publicationOptions.personal,
          account: nextAccount,
          generation: "e08f9472-c435-4d8d-b970-fb97da80a642",
        },
      };
      await gateway.setMethodResponse("sessions.github.options", next);
      await publicationAction(page, "Refresh publication").click();
      await expect.poll(() => publish.isEnabled()).toBe(true);
      await selectPublicationAccount(page, source);
      const selectedAccount = page.locator(
        `.chat-pr__accounts-panel [role="menuitemradio"][value="${source}"][aria-checked="true"]`,
      );
      await selectedAccount.waitFor({ state: "hidden" });
      expect(await selectedAccount.textContent()).toContain("@publisher-current");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, `${source}-refreshed-selection.png`),
        });
      }
      await gateway.deferNext("sessions.github.publish");
      await publish.click();
      const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
      expect(second.params).toMatchObject({
        sessionKey: "agent:main:main",
        selection:
          source === "shared"
            ? { source, expected: next.shared }
            : { source, generation: next.personal.generation, account: nextAccount },
      });
      expect(second.params).not.toHaveProperty("idempotencyKey", first.params.idempotencyKey);
      await gateway.resolveDeferred("sessions.github.publish", {
        requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b4",
        status: "published",
        publisher: {
          source: source === "shared" ? sharedPublisher.source : "personal",
          ...nextAccount,
        },
        url: "https://github.com/synthetic/publication-demo/pull/42",
        repository: "synthetic/publication-demo",
        branch: "fix/publisher-recovery",
        headCommit: "a".repeat(40),
      });
      await page.getByRole("link", { name: "Open PR", exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(2);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, `${source}-explicit-publication.png`),
        });
      }
      const openPr = page.getByRole("link", { name: "Open PR", exact: true });
      expect(await openPr.getAttribute("href")).toBe(
        "https://github.com/synthetic/publication-demo/pull/42",
      );
      const newPublication = publicationAction(page, "Dismiss");
      await expect.poll(() => newPublication.count()).toBe(1);
      await newPublication.click();
      await expect.poll(() => publish.isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(2);
      await selectPublicationAccount(page, source);
      await gateway.deferNext("sessions.github.publish");
      await publish.click();
      const third = await gateway.waitForRequest("sessions.github.publish", { after: 2 });
      expect(third.params).toMatchObject({
        sessionKey: "agent:main:main",
        selection:
          source === "shared"
            ? { source, expected: next.shared }
            : { source, generation: next.personal.generation, account: nextAccount },
      });
      if (!isRecord(second.params)) {
        throw new Error("Publication parameters were not an object");
      }
      expect(third.params).not.toHaveProperty("idempotencyKey", second.params.idempotencyKey);
    },
  );

  it("freezes an explicitly selected personal account through a lost response and shows the server actor", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installPublicationGateway(page, {
      presenceUsers: viewer("alice", "Alice"),
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await openDetailsPullRequests(page);
    const chooser = publicationAction(page, "Publication account");
    await chooser.click();
    const shared = page.getByRole("menuitemradio", { name: "@system-bot", exact: true });
    expect(await shared.getAttribute("aria-checked")).toBe("true");
    const personal = page.getByRole("menuitemradio", { name: "@alice-tools", exact: true });
    await personal.click();
    await personal.waitFor({ state: "hidden" });
    expect(
      await page
        .locator('.chat-pr__accounts-panel [role="menuitemradio"][value="personal"]')
        .getAttribute("aria-checked"),
    ).toBe("true");
    await gateway.deferNext("sessions.github.publish");
    await page.getByRole("button", { name: "Publish PR" }).click();
    const first = await gateway.waitForRequest("sessions.github.publish");
    expect(first.params).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
      idempotencyKey: expect.any(String),
      selection: { source: "personal", generation: personalGeneration, account: personalAccount },
    });
    await expect.poll(() => chooser.count()).toBe(0);
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Response lost.",
    });
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).count())
      .toBe(1);
    await expect.poll(() => chooser.count()).toBe(0);
    await gateway.setMethodResponse("sessions.github.options", {
      ...publicationOptions,
      personal: {
        ...publicationOptions.personal,
        generation: "other-generation",
        account: { accountId: 4, login: "replacement" },
      },
    });
    await page.getByRole("button", { name: "Refresh publication" }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).isEnabled())
      .toBe(true);
    await expect.poll(() => chooser.count()).toBe(0);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    expect(await page.locator(".chat-pr__publication-outcome").textContent()).not.toContain(
      "replacement",
    );
    await gateway.setMethodResponse("sessions.github.publish", {
      requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b2",
      status: "failed",
      code: "identity_changed",
      publisher: { source: "personal", ...personalAccount },
      message: "The selected connection changed.",
      nextAction: "Review the account and choose a new publication.",
    });
    await page.getByRole("button", { name: "Retry publication" }).click();
    const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(second.params).toEqual(first.params);
    await expect
      .poll(() => page.getByRole("button", { name: "Choose a new publication" }).count())
      .toBe(1);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    await expect
      .poll(() => page.locator(".chat-pr__publication-outcome").textContent())
      .toContain("My GitHub");
    expect(await gateway.getRequests("secrets.set")).toHaveLength(0);
    await publicationScreenshot(suite, page, "05-personal-identity-changed.png", [
      page.getByRole("button", { name: "Choose a new publication" }),
    ]);
  });

  it.each(["local", "reclaimed"])(
    "recovers the original personal request in a %s workspace and confirms its account, target, and snapshot",
    async (state) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b3";
      const confirmation = confirmationFixture("team/demo", "alice/demo", "feature/original");
      const gateway = await installPublicationGateway(page, {
        sessions: [
          createControlUiSessionRow("agent:main:main", "Publication workspace", Date.now(), {
            placement: {
              state,
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
            },
          }),
        ],
        presenceUsers: viewer("alice", "Alice"),
        methodResponses: {
          "sessions.github.options": {
            ...publicationOptions,
            pendingPersonal: {
              result: {
                requestId,
                status: "needs_confirmation",
                publisher: { source: "personal", ...personalAccount },
                message: "Review the original publication before continuing.",
                effect: { kind: "push", status: "dispatched", headCommit: "4".repeat(40) },
              },
              confirmation,
            },
          },
          "sessions.github.confirm": {
            requestId,
            status: "published",
            publisher: { source: "personal", ...personalAccount },
            url: "https://github.com/team/demo/pull/42",
            repository: "team/demo",
            branch: "feature/original",
            headCommit: "4".repeat(40),
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway);
      await openDetailsPullRequests(page);
      await page.getByRole("button", { name: "Confirm original publication" }).waitFor();
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
      await page.reload();
      await showPublicationBranch(gateway);
      await openDetailsPullRequests(page);
      const details = page.locator(".chat-pr__publication-outcome");
      await expect.poll(() => details.textContent()).toContain("Publish as @alice-tools");
      await expect.poll(() => details.textContent()).toContain("team/demo → main");
      await expect.poll(() => details.textContent()).toContain("alice/demo · feature/original");
      await details.getByText("Original accepted snapshot", { exact: true }).click();
      await expect
        .poll(() => details.locator(".chat-pr__publication-note details").textContent())
        .toContain(confirmation.workspaceTree);
      await expect
        .poll(() => details.textContent())
        .toContain("remote outcome may still be unknown");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
      await publicationScreenshot(suite, page, "06-original-confirmation.png", [details]);
      await page.getByRole("button", { name: "Confirm original publication" }).click();
      const confirmed = await gateway.waitForRequest("sessions.github.confirm");
      expect(confirmed.params).toEqual({
        sessionKey: "agent:main:main",
        agentId: "main",
        requestId,
        requestDigest: confirmation.requestDigest,
        generation: personalGeneration,
        account: personalAccount,
      });
      await expect
        .poll(() => page.getByRole("link", { name: "Open PR" }).getAttribute("href"))
        .toBe("https://github.com/team/demo/pull/42");
      expect(await page.locator(".chat-pr__publication-outcome").count()).toBe(0);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    },
  );

  it("acknowledges a completed personal publication with read scope without publishing", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b5";
    const gateway = await installPublicationGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      operatorScopes: ["operator.read"],
      presenceUsers: viewer("alice", "Alice"),
      methodResponses: {
        "sessions.github.options": {
          ...publicationOptions,
          pendingPersonal: {
            result: {
              requestId,
              status: "publishing",
              publisher: { source: "personal", ...personalAccount },
              message: "The original publication is still running.",
            },
            confirmation: null,
          },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await openDetailsPullRequests(page);
    await page
      .getByText("The original publication is still running.", { exact: true })
      .waitFor({ state: "attached" });
    // The same profile's writer completes the request; this connection only reads it.
    await gateway.setMethodResponse("sessions.github.status", {
      result: {
        requestId,
        status: "published",
        publisher: { source: "personal", ...personalAccount },
        url: "https://github.com/synthetic/publication-demo/pull/42",
        repository: "synthetic/publication-demo",
        branch: "feature/original",
        headCommit: "a".repeat(40),
      },
      confirmation: null,
    });
    await gateway.setMethodResponse("sessions.github.options", publicationOptions);
    await publicationAction(page, "Check publication").click();
    const statusRequest = await gateway.waitForRequest("sessions.github.status");
    expect(statusRequest.params).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
      requestId,
    });
    const openPr = page.getByRole("link", { name: "Open PR", exact: true });
    await openPr.waitFor();
    expect(await openPr.getAttribute("href")).toBe(
      "https://github.com/synthetic/publication-demo/pull/42",
    );
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    await publicationScreenshot(suite, page, "read-only-completed-publication.png", [openPr]);
    const dismiss = page.locator(".chat-prs").getByRole("button", {
      name: "Dismiss",
      exact: true,
    });
    await expect.poll(() => dismiss.count()).toBe(1);
    const previousOptions = (await gateway.getRequests("sessions.github.options")).length;
    await dismiss.click();
    await gateway.waitForRequest("sessions.github.options", { after: previousOptions });
    await openPr.waitFor({ state: "hidden" });
    expect(await publicationAction(page, "Publish PR").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Confirm original publication" }).count()).toBe(
      0,
    );
    expect(await publicationAction(page, "Publication account").count()).toBe(0);
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
  });

  it("removes publication mutation controls when the connection becomes read-only", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installPublicationGateway(page, {
      presenceUsers: viewer("alice", "Alice"),
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await openDetailsPullRequests(page);
    await page.getByRole("button", { name: "Publication account" }).click();
    await page.locator('.chat-pr__accounts-panel [role="menuitemradio"][value="personal"]').click();
    await gateway.deferNext("sessions.github.publish");
    await page.getByRole("button", { name: "Publish PR" }).click();
    await gateway.waitForRequest("sessions.github.publish");
    const previousSubscriptions = (
      await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)
    ).length;
    await gateway.setOperatorScopes(["operator.read"]);
    await gateway.closeLatest();
    // The new subscription proves the replacement handshake has been applied.
    await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      after: previousSubscriptions,
    });
    await showPublicationBranch(gateway);
    await openDetailsPullRequests(page);
    await expect.poll(() => publicationAction(page, "Publication account").count()).toBe(0);
    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "stale",
      status: "published",
      publisher: { source: "personal", ...personalAccount },
      url: "https://github.com/team/demo/pull/99",
      repository: "team/demo",
      branch: "feature/old",
      headCommit: "a".repeat(40),
    });
    await expect.poll(() => page.getByRole("button", { name: "Publish PR" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Open PR" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
  });
});
