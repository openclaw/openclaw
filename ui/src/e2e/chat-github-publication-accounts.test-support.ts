import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
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
      const arrow = page.getByRole("button", { name: "Publication account" });
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
      await page.locator(".chat-thread").click();
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
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
        "sessions.github.options": { ...publicationOptions, shared: null },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    const publish = page.getByRole("button", { name: "Publish as @alice-tools", exact: true });
    await publish.waitFor();
    expect(await publish.isEnabled()).toBe(true);
    expect(
      await page.getByRole("button", { name: "Publication account", exact: true }).count(),
    ).toBe(0);
    expect(await page.locator(".chat-pr wa-dropdown").count()).toBe(0);
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
        await page.getByRole("button", { name: "Publication account" }).click();
        await page.getByRole("menuitemradio", { name: "@alice-tools", exact: true }).waitFor();
      }
    },
  );
}
