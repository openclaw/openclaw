import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { closeChatDetails, openChatPublication } from "./chat-details.test-support.ts";
import { exactButton as publicationAction } from "./chat-flow.test-support.ts";
import {
  personalAccount,
  personalGeneration,
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export { publicationAction };

export async function selectPublicationAccount(root: Page | Locator, source: string) {
  await publicationAction(root, "Publication account").click();
  await root.locator(`.chat-pr__accounts-panel [role="menuitemradio"][value="${source}"]`).click();
}

export function installPublicationGateway(
  page: Page,
  options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
) {
  return installMockGateway(page, {
    operatorScopes: ["operator.read", "operator.write"],
    featureMethods: publicationMethods,
    ...options,
    methodResponses: {
      [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      "sessions.github.options": publicationOptions,
      ...options.methodResponses,
    },
  });
}

const unknownAvailability =
  "GitHub publication account verification is unavailable. Reload and retry, or check gh auth status on the Gateway runtime host. Settings connections are optional; My GitHub is separate.";
function availability(
  reason: string | undefined,
  message: string | undefined,
  extra: { name?: string; native?: boolean; unidentified?: boolean } = {},
) {
  return { name: reason?.replaceAll("_", "-") ?? "unknown", reason, message, ...extra };
}

export function defineGitHubPublicationAccountTests({
  suite,
  newPublicationContext,
}: {
  suite: ReturnType<typeof createControlUiE2eSuite>;
  newPublicationContext: () => Promise<BrowserContext>;
}) {
  async function openPublication(
    options: Parameters<typeof installPublicationGateway>[1] = {},
    width?: number,
  ) {
    const page = await (await newPublicationContext()).newPage();
    if (width) {
      await page.setViewportSize({ width, height: 800 });
    }
    const gateway = await installPublicationGateway(page, options);
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    return { page, gateway };
  }

  it.each([
    availability(
      "unavailable",
      "No usable GitHub credential is available in the Gateway environment. Sign in with gh auth login on the Gateway runtime host, or optionally add a connection in Settings → Profile → GitHub connections. My GitHub is separate and optional.",
    ),
    availability("changed", "The Gateway GitHub account changed. Reload and retry publication."),
    availability(
      "rate_limited",
      "GitHub rate-limited account verification. Wait and retry publication; reconnecting is not needed.",
    ),
    availability(
      "unverified",
      "GitHub account verification is unavailable. Retry publication or check gh auth status on the Gateway runtime host.",
    ),
    availability(
      "unsupported_workspace",
      "Publish PR needs a session-owned worktree or repository workspace. Normal agent gh commands still work; reconnecting GitHub will not help.",
    ),
    availability(undefined, unknownAvailability),
    availability(undefined, unknownAvailability, {
      name: "unknown-unidentified",
      unidentified: true,
    }),
    availability(undefined, undefined, { name: "native-publisher", native: true }),
    availability(undefined, undefined, {
      name: "native-publisher-unidentified",
      native: true,
      unidentified: true,
    }),
  ])("explains $name publication availability without requiring a connection", async (scenario) => {
    const { page, gateway } = await openPublication({
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      methodResponses: {
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
    const discovered = await gateway.waitForRequest("sessions.github.options");
    expect(discovered.params).toEqual({ sessionKey: "agent:main:main", agentId: "main" });
    await openChatPublication(page);
    const publish = publicationAction(page, "Publish PR");
    await publish.waitFor();
    await expect.poll(() => publish.isEnabled()).toBe(Boolean(scenario.native));
    const row = page.locator('.chat-pr[data-state="branch"]');
    const note = row.locator(".chat-pr__publication-note");
    const refresh = publicationAction(row, "Refresh publication");
    if (!scenario.native) {
      await note.waitFor();
      expect(await refresh.count()).toBe(1);
      expect(await refresh.isEnabled()).toBe(true);
      expect(await note.textContent()).toContain(scenario.message);
    } else {
      expect(await note.count()).toBe(0);
      expect(await refresh.count()).toBe(0);
    }
    expect(await row.textContent()).not.toContain("Connect GitHub in Settings");
    expect(await publicationAction(page, "Publication account").count()).toBe(0);
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
      const { page, gateway } = await openPublication({}, width);
      await openChatPublication(page);
      const arrow = page.getByRole("button", {
        name: "Publication account",
        includeHidden: true,
      });
      await arrow.waitFor();
      const menu = page.locator(".chat-pr__accounts-panel");
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
      expect(await publicationAction(page, "Publish PR").count()).toBe(1);
      await expect
        .poll(() => arrow.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await showPublicationBranch(gateway, "openclaw/updated-branch");
      await openChatPublication(page);
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
      if (width === 390) {
        // The retained mobile host closes through its own control in this prefix.
        await page.locator(".chat-mobile-host").waitFor({ state: "visible" });
        await closeChatDetails(page);
        await page.locator(".chat-mobile-host").waitFor({ state: "hidden" });
      } else {
        expect(await page.locator(".chat-details-toggle").getAttribute("aria-expanded")).toBe(
          "false",
        );
      }
      await openChatPublication(page);
      expect(await personal.isVisible()).toBe(false);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    },
  );

  it("publishes as the sole personal account only after the explicit labeled action", async () => {
    const { page, gateway } = await openPublication({
      methodResponses: {
        "sessions.github.options": {
          ...publicationOptions,
          shared: null,
          sharedUnavailableReason: "rate_limited",
        },
      },
    });
    await openChatPublication(page);
    const publish = publicationAction(page, "Publish as @alice-tools");
    await publish.waitFor();
    expect(await publish.isEnabled()).toBe(true);
    expect(await publicationAction(page, "Publication account").count()).toBe(0);
    expect(await page.locator(".chat-pr__accounts-panel").count()).toBe(0);
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
    async ({ state, running, conflict, ready }) => {
      const now = Date.now();
      const { page } = await openPublication({
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
              workspaceResultConflict: conflict
                ? {
                    paths: ["src/example.ts"],
                    stagedResultRef: "refs/openclaw/worker-results/test",
                    totalCount: 1,
                  }
                : undefined,
            },
          }),
        ],
      });
      await openChatPublication(page);
      await selectPublicationAccount(page, "personal");
      const publish = page.getByRole("button", { name: "Publish PR" });
      await publish.waitFor();

      await expect.poll(() => publish.isEnabled()).toBe(ready);
      if (conflict) {
        const notice = page.locator(".chat-workspace-conflict-notice");
        await notice.getByRole("button", { name: "Dismiss workspace conflict notice" }).click();
        await notice.waitFor({ state: "hidden" });
        await openChatPublication(page);
        await page.getByRole("button", { name: "Publication account" }).click();
        await page.getByRole("menuitemradio", { name: "@alice-tools", exact: true }).waitFor();
      }
    },
  );
}
