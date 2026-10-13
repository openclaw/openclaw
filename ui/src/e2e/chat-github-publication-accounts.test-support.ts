import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openDetailsPullRequests } from "./chat-details.test-support.ts";
import {
  personalAccount,
  personalGeneration,
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function defineGitHubPublicationAccountTests({
  suite,
  newPublicationContext,
  captureUiProof,
}: {
  suite: ReturnType<typeof createControlUiE2eSuite>;
  newPublicationContext: () => Promise<BrowserContext>;
  captureUiProof: boolean;
}) {
  it.each([
    {
      name: "unavailable",
      reason: "unavailable",
      message:
        "No usable GitHub credential is available in the Gateway environment. Sign in with gh auth login on the Gateway runtime host, or optionally add a connection in Settings → Profile → GitHub connections. My GitHub is separate and optional.",
    },
    {
      name: "changed",
      reason: "changed",
      message: "The Gateway GitHub account changed. Reload and retry publication.",
    },
    {
      name: "rate-limited",
      reason: "rate_limited",
      message:
        "GitHub rate-limited account verification. Wait and retry publication; reconnecting is not needed.",
    },
    {
      name: "unverified",
      reason: "unverified",
      message:
        "GitHub account verification is unavailable. Retry publication or check gh auth status on the Gateway runtime host.",
    },
    {
      name: "unsupported-workspace",
      reason: "unsupported_workspace",
      message:
        "Publish PR needs a session-owned worktree or repository workspace. Normal agent gh commands still work; reconnecting GitHub will not help.",
    },
    {
      name: "unknown",
      reason: undefined,
      message:
        "GitHub publication account verification is unavailable. Reload and retry, or check gh auth status on the Gateway runtime host. Settings connections are optional; My GitHub is separate.",
    },
    {
      name: "unknown-unidentified",
      reason: undefined,
      unidentified: true,
      message:
        "GitHub publication account verification is unavailable. Reload and retry, or check gh auth status on the Gateway runtime host. Settings connections are optional; My GitHub is separate.",
    },
    { name: "native-publisher", reason: undefined, native: true, message: undefined },
    {
      name: "native-publisher-unidentified",
      reason: undefined,
      native: true,
      unidentified: true,
      message: undefined,
    },
  ])("explains $name publication availability without requiring a connection", async (scenario) => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": {
          ...publicationOptions,
          shared: scenario.native
            ? { ...publicationOptions.shared, source: "system-detected" }
            : null,
          personal: scenario.unidentified
            ? null
            : {
                ...publicationOptions.personal,
                state: "disconnected",
                account: null,
                generation: null,
              },
          ...(scenario.reason ? { sharedUnavailableReason: scenario.reason } : {}),
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway, "fix/publication-availability");
    const discovered = await gateway.waitForRequest("sessions.github.options");
    expect(discovered.params).toEqual({ sessionKey: "agent:main:main", agentId: "main" });
    await openDetailsPullRequests(page);
    const publish = page.getByRole("button", { name: "Publish PR", exact: true });
    await publish.waitFor();
    await expect.poll(() => publish.isEnabled()).toBe(Boolean(scenario.native));
    const row = page.locator('.chat-pr[data-state="branch"]');
    const note = row.locator(".chat-pr__publication-note");
    const refresh = row.getByRole("button", { name: "Refresh publication", exact: true });
    if (!scenario.native) {
      await note.waitFor();
      expect(await refresh.count()).toBe(1);
      expect(await refresh.isEnabled()).toBe(true);
      if (captureUiProof) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [publish, note, refresh],
          {
            animations: "disabled",
            elements: [row],
          },
        );
        await writeFile(
          path.join(suite.artifactDir, `${scenario.name}-availability.png`),
          frame.png,
        );
        await writeFile(
          path.join(suite.artifactDir, `${scenario.name}-banner.png`),
          frame.elements[0]!.png,
        );
      }
      expect(await note.textContent()).toContain(scenario.message);
    } else {
      expect(await note.count()).toBe(0);
      expect(await refresh.count()).toBe(0);
    }
    expect(await row.textContent()).not.toContain("Connect GitHub in Settings");
    expect(
      await page.getByRole("button", { name: "Publication account", exact: true }).count(),
    ).toBe(0);
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    if (scenario.name === "changed") {
      const previousOptions = (await gateway.getRequests("sessions.github.options")).length;
      await gateway.setMethodResponse("sessions.github.options", {
        ...publicationOptions,
        personal: null,
        shared: { ...publicationOptions.shared, source: "system-detected" },
      });
      await refresh.click();
      const retried = await gateway.waitForRequest("sessions.github.options", {
        after: previousOptions,
      });
      expect(retried.params).toEqual({ sessionKey: "agent:main:main", agentId: "main" });
      await expect.poll(() => publish.isEnabled()).toBe(true);
      await note.waitFor({ state: "hidden" });
      expect(await refresh.count()).toBe(0);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    }
  });

  it.each([1180, 390])(
    "keeps the account menu compact and keyboard accessible at %ipx",
    async (width) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: publicationMethods,
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway);
      await openDetailsPullRequests(page);
      const arrow = page.getByRole("button", {
        name: "Publication account",
        includeHidden: true,
      });
      await arrow.waitFor();
      const menu = page.locator(".chat-pr wa-dropdown");
      const shared = menu.getByRole("menuitemradio", { name: "@system-bot", exact: true });
      const personal = menu.getByRole("menuitemradio", { name: "@alice-tools", exact: true });
      expect(await shared.isVisible()).toBe(false);
      expect(await menu.locator("select").count()).toBe(0);
      const row = page.locator('.chat-pr[data-state="branch"]');
      const closedBounds = await row.boundingBox();
      expect(closedBounds).not.toBeNull();
      await arrow.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => arrow.getAttribute("aria-expanded")).toBe("true");
      await shared.waitFor();
      expect(await shared.getAttribute("aria-checked")).toBe("true");
      expect(await personal.getAttribute("aria-checked")).toBe("false");
      expect((await row.boundingBox())?.height).toBe(closedBounds?.height);
      const accountBounds = await shared.boundingBox();
      expect(accountBounds).not.toBeNull();
      expect(accountBounds!.x).toBeGreaterThanOrEqual(0);
      expect(accountBounds!.x + accountBounds!.width).toBeLessThanOrEqual(width);
      await shared.focus();
      await page.keyboard.press("ArrowDown");
      expect(await personal.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
      expect(await menu.locator('[value="personal"]').getAttribute("aria-checked")).toBe("true");
      expect(await page.getByRole("button", { name: "Publish PR", exact: true }).count()).toBe(1);
      await expect
        .poll(() => arrow.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await showPublicationBranch(gateway, "openclaw/updated-branch");
      await openDetailsPullRequests(page);
      await row
        .getByText("openclaw/updated-branch", { exact: true })
        .waitFor({ state: "attached" });
      await arrow.click();
      await personal.waitFor();
      expect(await personal.getAttribute("aria-checked")).toBe("true");
      expect(await shared.getAttribute("aria-checked")).toBe("false");
      await page.keyboard.press("Escape");
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
      await arrow.click();
      await personal.waitFor();
      await page.locator(".agent-chat__input textarea").click();
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator(".chat-details-toggle").getAttribute("aria-expanded")).toBe(
        "false",
      );
      await openDetailsPullRequests(page);
      expect(await personal.isVisible()).toBe(false);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    },
  );

  it("publishes as the sole personal account only after the explicit labeled action", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": {
          ...publicationOptions,
          shared: null,
          sharedUnavailableReason: "rate_limited",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await openDetailsPullRequests(page);
    const publish = page.getByRole("button", { name: "Publish as @alice-tools", exact: true });
    await publish.waitFor();
    expect(await publish.isEnabled()).toBe(true);
    expect(
      await page.getByRole("button", { name: "Publication account", exact: true }).count(),
    ).toBe(0);
    expect(await page.locator(".chat-pr wa-dropdown").count()).toBe(0);
    expect(await page.locator(".chat-pr__publication-note").count()).toBe(0);
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    await gateway.deferNext("sessions.github.publish");
    await publish.click();
    const request = await gateway.waitForRequest("sessions.github.publish");
    expect(request.params).toMatchObject({
      selection: { source: "personal", generation: personalGeneration, account: personalAccount },
    });
  });

  it.each([
    { name: "reclaimed", state: "reclaimed", running: false, conflict: false, ready: true },
    { name: "remote", state: "active", running: false, conflict: false, ready: false },
    { name: "running", state: "reclaimed", running: true, conflict: false, ready: false },
    { name: "conflicted", state: "reclaimed", running: false, conflict: true, ready: false },
  ])(
    "gates personal publication for a $name workspace",
    async ({ name, state, running, conflict, ready }) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: publicationMethods,
        sessions: [
          createControlUiSessionRow("agent:main:main", "Publication workspace", now, {
            hasActiveRun: running,
            status: running ? "running" : "done",
            placement: {
              state,
              generation: 1,
              createdAtMs: now,
              updatedAtMs: now,
              stateChangedAtMs: now,
              ...(conflict
                ? {
                    workspaceResultConflict: {
                      paths: ["src/example.ts"],
                      stagedResultRef: "refs/openclaw/worker-results/test",
                      totalCount: 1,
                    },
                  }
                : {}),
            },
          }),
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway);
      await openDetailsPullRequests(page);
      await page.getByRole("button", { name: "Publication account" }).click();
      await page.locator('wa-dropdown-item[value="personal"]').click();
      const publish = page.getByRole("button", { name: "Publish PR" });
      await publish.waitFor();
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, `${name}-workspace.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [publish]),
        );
      }
      await expect.poll(() => publish.isEnabled()).toBe(ready);
      if (conflict) {
        const notice = page.locator(".chat-workspace-conflict-notice");
        await notice.getByRole("button", { name: "Dismiss workspace conflict notice" }).click();
        await notice.waitFor({ state: "hidden" });
        await openDetailsPullRequests(page);
        await page.getByRole("button", { name: "Publication account" }).click();
        await page.getByRole("menuitemradio", { name: "@alice-tools", exact: true }).waitFor();
      }
    },
  );
}
