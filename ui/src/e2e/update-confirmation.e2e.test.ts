import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update confirmation E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const UPDATE_AVAILABLE = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
} as const;
const UPDATE_RUN_RESPONSE = {
  ok: true,
  runId: createUpdateRunFixture().runId,
  restart: null,
  result: { after: { version: "2.0.0" }, status: "ok" },
} as const;

/** The dialog element lives in a shadow root; its visible copy is slotted light DOM. */
function confirmationCopy(page: Page) {
  return page.locator("openclaw-modal-dialog");
}

function button(root: Page | Locator, name: string) {
  return root.getByRole("button", { name, exact: true });
}

function confirmationDialog(page: Page) {
  return page.getByRole("dialog", { name: "Update Gateway", exact: true });
}

function gitStatus(sha: string, behind: number, available: Partial<UpdateAvailable> = {}) {
  return {
    updateAvailable: {
      channel: "beta" as const,
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      currentSha: "a".repeat(40),
      upstreamSha: sha.repeat(40),
      commitsBehind: behind,
      ...available,
    },
    schedule: {
      channel: "beta",
      autoEnabled: false,
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: sha.repeat(40),
        commitsBehind: behind,
      },
    } satisfies UpdateScheduleState,
  };
}

async function restoreNative(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          openclawUpdate: {
            postMessage: () => {
              document.documentElement.dataset.nativeUpdatePosted = "yes";
            },
          },
        },
      },
    });
  });
}

function updateCard(page: Page) {
  return page.locator('openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]');
}

function revisions(page: Page) {
  return confirmationCopy(page).locator(".update-git-revisions");
}

function createFailedRun() {
  return {
    ...createUpdateRunFixture(),
    status: "failed" as const,
    phase: "finished" as const,
    reason: "build-failed",
    finishedAtMs: Date.now(),
  };
}

async function openUpdateCard(page: Page, baseUrl: string) {
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "update.run": UPDATE_RUN_RESPONSE,
      "update.runs.get": { run: createUpdateRunFixture() },
    },
  });
  expect((await page.goto(`${baseUrl}chat`))?.status()).toBe(200);
  await gateway.waitForRequest("sessions.messages.subscribe");
  await gateway.setMethodResponse("update.status", { updateAvailable: UPDATE_AVAILABLE });
  await gateway.emitGatewayEvent("update.available", { updateAvailable: UPDATE_AVAILABLE });
  await page.locator(".sidebar-issues-button:visible").click();
  const updateIssue = updateCard(page);
  await updateIssue.locator("summary").click();
  const updateButton = updateIssue.locator(".sidebar-update-card__action");
  await updateButton.waitFor({ timeout: 10_000 });
  // Expansion refreshes the target; the action stays disabled until that check settles.
  await expect.poll(() => updateButton.isEnabled()).toBe(true);
  return { gateway, updateButton };
}

function withPage(run: (page: Page) => Promise<void>, height = 900) {
  return suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { height, width: 1280 } },
    ({ page }) => run(page),
  );
}

suite.define(() => {
  it.each(["absent", "before-confirm", "before-retry"] as const)(
    "checks a fresh Gateway target before falling back from a vanished native bridge with restore=%s",
    async (restore) => {
      await withPage(async (page) => {
        await page.addInitScript(() => {
          Object.defineProperty(window, "webkit", {
            configurable: true,
            value: { messageHandlers: { openclawUpdate: { postMessage: () => undefined } } },
          });
        });
        const stale = gitStatus("b", 7);
        const gateway = await installMockGateway(page, {
          updateAvailable: stale.updateAvailable,
          updateSchedule: stale.schedule,
          methodResponses: { "update.status": stale, "update.run": UPDATE_RUN_RESPONSE },
        });
        expect((await page.goto(suite.server.baseUrl + "chat"))?.status()).toBe(200);
        await gateway.waitForRequest("sessions.messages.subscribe");
        await page.locator(".sidebar-issues-button:visible").click();
        const card = updateCard(page);
        await card.locator("summary").click();
        await card.locator(".sidebar-update-card__action").click();
        await page.evaluate(() => Reflect.deleteProperty(window, "webkit"));
        await gateway.deferNext("update.status", { refreshCheckout: true });
        await button(page, "Update Mac app and restart").click();
        await gateway.waitForRequest("update.status", { match: { refreshCheckout: true } });
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        expect(await revisions(page).count()).toBe(0);
        expect(await confirmationCopy(page).locator(".btn.danger").isDisabled()).toBe(true);
        await gateway.rejectDeferred("update.status", {
          code: "UNAVAILABLE",
          message: "Latest target unavailable.",
        });
        await confirmationCopy(page).getByRole("alert").waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await gateway.setMethodResponse("update.status", gitStatus("c", 9));
        await button(page, "Update Mac app and restart").click();
        await confirmationDialog(page).waitFor();
        expect(await revisions(page).textContent()).toContain("cccccccc");
        expect(await revisions(page).textContent()).not.toContain("bbbbbbbb");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        if (restore === "before-confirm") {
          await restoreNative(page);
          await button(page, "Update and restart").click();
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await button(page, "Update Mac app and restart").click();
          expect(await page.locator("html").getAttribute("data-native-update-posted")).toBe("yes");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          return;
        }
        const failedRun = createFailedRun();
        await gateway.setMethodResponse("update.runs.get", { run: failedRun });
        await button(page, "Update and restart").click();
        await gateway.waitForRequest("update.run");
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        await button(page, "Retry update").waitFor();
        if (restore === "before-retry") {
          await restoreNative(page);
          await button(page, "Retry update").click();
          expect(await confirmationCopy(page).getAttribute("label")).toBe(
            "Update Mac app + Gateway",
          );
          await button(page, "Update Mac app and restart").click();
          expect(await page.locator("html").getAttribute("data-native-update-posted")).toBe("yes");
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
          return;
        }

        await gateway.setMethodResponse("update.status", {
          ...gitStatus("d", 10),
          activeRun: null,
          lastRun: failedRun,
        });
        await button(page, "Retry update").click();
        await gateway.waitForRequest("update.status", {
          after: 2,
          match: { refreshCheckout: true },
        });
        await button(page, "Update and restart").waitFor();
        expect(await revisions(page).textContent()).toContain("dddddddd");
        expect(await revisions(page).textContent()).not.toContain("cccccccc");
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        await button(page, "Cancel").click();
      });
    },
  );

  it.each(["gateway", "native"] as const)(
    "keeps failed-run retry open and uses the current %s owner",
    async (owner) => {
      await withPage(async (page) => {
        const run = {
          ...createFailedRun(),
          target: { kind: "git" as const, sha: "b".repeat(40) },
        };
        const status = (sha: string, behind: number) => ({
          ...gitStatus(sha, behind, { upstreamRef: "origin/main" }),
          activeRun: null,
          lastRun: run,
        });
        const stale = status("b", 7);
        const gateway = await installMockGateway(page, {
          updateAvailable: stale.updateAvailable,
          updateSchedule: stale.schedule,
          methodResponses: { "update.status": stale, "update.runs.get": { run } },
        });
        expect((await page.goto(suite.server.baseUrl + "chat"))?.status()).toBe(200);
        await gateway.waitForRequest("sessions.messages.subscribe");
        await page.locator(".sidebar-issues-button:visible").click();
        const card = updateCard(page);
        await card.locator("summary").click();
        await card.locator(".sidebar-update-card__action").click();
        await waitForConfirmModal(page);

        if (owner === "native") {
          await restoreNative(page);
          await button(page, "Retry update").click();
          await button(page, "Update Mac app and restart").waitFor();
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          expect(
            await gateway.getRequests("update.status", { refreshCheckout: true }),
          ).toHaveLength(0);
          await button(page, "Update Mac app and restart").click();
          expect(await page.locator("html").getAttribute("data-native-update-posted")).toBe("yes");
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          return;
        }

        await gateway.deferNext("update.status", { refreshCheckout: true });
        await button(page, "Retry update").click();
        await gateway.waitForRequest("update.status", { match: { refreshCheckout: true } });
        expect(await confirmationDialog(page).count()).toBe(1);
        expect(await button(page, "Retry update").isDisabled()).toBe(true);
        await gateway.rejectDeferred("update.status", {
          code: "UNAVAILABLE",
          message: "Latest target unavailable.",
        });
        await confirmationCopy(page)
          .getByText("Status could not be refreshed. Check your connection and try again.", {
            exact: true,
          })
          .waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(0);

        await gateway.setMethodResponse("update.status", status("c", 9));
        await button(page, "Retry update").click();
        await button(confirmationCopy(page), "Update and restart").waitFor();
        expect(await confirmationCopy(page).textContent()).toContain("9 commits behind");
        expect(await revisions(page).textContent()).toContain("cccccccc");
        expect(await revisions(page).textContent()).not.toContain("bbbbbbbb");
        expect(await gateway.getRequests("update.status", { refreshCheckout: true })).toHaveLength(
          2,
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await button(page, "Cancel").click();
      });
    },
  );

  it("refreshes the Git release target when opening the update card and again before confirmation", async () => {
    await withPage(async (page) => {
      const status = (sha: string, behind: number) =>
        gitStatus(sha, behind, {
          upstreamRef: "origin/main",
          repositoryUrl: "https://github.com/openclaw/openclaw",
        });
      const stale = status("b", 7);
      const gateway = await installMockGateway(page, {
        updateAvailable: stale.updateAvailable,
        updateSchedule: stale.schedule,
        methodResponses: { "update.status": stale },
      });
      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("sessions.messages.subscribe");
      await page.locator(".sidebar-issues-button:visible").click();
      const card = updateCard(page);
      await card.waitFor();
      await gateway.setMethodResponse("update.status", status("c", 9));
      await card.locator("summary").click();
      await card.locator(".update-git-revisions code", { hasText: "cccccccc" }).waitFor();
      expect(await gateway.getRequests("update.status", { refreshCheckout: true })).toHaveLength(1);
      expect(await card.locator(".update-git-revisions a").getAttribute("href")).toBe(
        `https://github.com/openclaw/openclaw/compare/${"a".repeat(40)}...${"c".repeat(40)}`,
      );
      await gateway.setMethodResponse("update.status", status("d", 10));
      await card.locator(".sidebar-update-card__action").click();
      await confirmationDialog(page).waitFor();
      expect(await confirmationCopy(page).textContent()).toContain("10 commits behind");
      expect(await revisions(page).textContent()).toContain("dddddddd");
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
      await button(page, "Cancel").click();
    });
  });

  it("keeps a dismissed Inbox update hidden until the Gateway boot changes", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        gatewayBootId: "gateway-boot-a",
        presenceUsers: [{ self: true, id: "alice", name: "Alice" }],
        operatorScopes: ["operator.admin", "operator.read"],
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: {
          channel: "stable",
          autoEnabled: false,
          target: { kind: "package", version: "2.0.0" },
        },
      });
      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("sessions.messages.subscribe");

      // The Inbox badge carries dismissible attention; the menu keeps release availability.
      const inboxBadge = page.locator(".sidebar-issues-button__count");
      await inboxBadge.waitFor();
      expect(
        await page
          .locator("openclaw-sidebar-attention")
          .evaluate((attention) =>
            [...attention.children]
              .map((child) => child.className)
              .filter((className) => typeof className === "string" && className.length > 0),
          ),
      ).toEqual(["sr-only", "sidebar-issues-button"]);

      await page.locator(".sidebar-issues-button").click();
      const updateIssue = updateCard(page);
      await updateIssue.waitFor();
      const dismissButton = updateIssue.locator(".sidebar-issues-panel__dismiss");
      await updateIssue.hover();
      await dismissButton.click();
      await updateIssue.waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await inboxBadge.waitFor({ state: "detached" });

      await page.locator(".sidebar-identity-card").click();
      await page
        .getByRole("menuitem", { name: "Updates. Update available", exact: true })
        .waitFor();
      await page
        .locator(".sidebar-identity-menu__update-badge")
        .getByText("Available", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");

      await page.reload();
      await gateway.waitForRequest("sessions.messages.subscribe");
      expect(await page.locator(".sidebar-issues-button__count").count()).toBe(0);

      await gateway.setGatewayBootId("gateway-boot-b");
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await inboxBadge.waitFor();
    }, 720);
  });

  it("keeps Inbox snoozes account-scoped without hiding release availability", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        gatewayBootId: "gateway-boot-accounts",
        presenceUsers: [{ self: true, id: "alice", name: "Alice" }],
        operatorScopes: ["operator.admin", "operator.read"],
        updateAvailable: UPDATE_AVAILABLE,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.messages.subscribe");
      const connect = await gateway.waitForRequest("connect");
      const instanceId = (connect.params as { client: { instanceId: string } }).client.instanceId;
      const inboxBadge = page.locator(".sidebar-issues-button__count");
      await inboxBadge.waitFor();
      await page.locator(".sidebar-issues-button").click();
      const updateIssue = updateCard(page);
      await updateIssue.hover();
      await updateIssue.locator(".sidebar-issues-panel__dismiss").click();
      await updateIssue.waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await inboxBadge.waitFor({ state: "detached" });

      for (const [id, name, snoozed] of [
        ["bob", "Bob", false],
        ["alice", "Alice", true],
      ] as const) {
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              instanceId,
              mode: "webchat",
              reason: "connect",
              user: { id, name },
              watchedSessions: [],
            },
          ],
        });
        await expect
          .poll(() => page.locator(".sidebar-identity-card").textContent())
          .toContain(name);
        await expect.poll(() => inboxBadge.count()).toBe(snoozed ? 0 : 1);
        await page.locator(".sidebar-identity-card").click();
        await page.locator(".sidebar-identity-menu").waitFor({ state: "visible" });
        await expect
          .poll(() =>
            page.locator(".sidebar-identity-menu .sidebar-identity-menu__update-badge").count(),
          )
          .toBe(1);
        await page.keyboard.press("Escape");
        await page.locator(".sidebar-identity-menu").waitFor({ state: "detached" });
      }
    });
  });

  it("keeps the update visible but non-dismissible for read-only operators", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        gatewayBootId: "gateway-boot-read-only",
        presenceUsers: [{ self: true, id: "alice", name: "Alice" }],
        operatorScopes: ["operator.read"],
        updateAvailable: UPDATE_AVAILABLE,
        updateSchedule: {
          channel: "stable",
          autoEnabled: false,
          target: { kind: "package", version: "2.0.0" },
        },
      });
      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("sessions.messages.subscribe");

      await page.locator(".sidebar-issues-button").click();
      const scopeGuidance = page.locator('[data-attention-kind="scopeUpgrade"]');
      await scopeGuidance.hover();
      await scopeGuidance.locator(".sidebar-issues-panel__dismiss").click();
      await scopeGuidance.waitFor({ state: "detached" });
      const updateIssue = updateCard(page);
      await updateIssue.waitFor();
      expect(await updateIssue.locator(".sidebar-issues-panel__dismiss").count()).toBe(0);
      expect(await page.locator(".sidebar-issues-button__count").count()).toBe(0);
      expect(await page.locator("#sidebar-issues-tab-all .hub-tab__badge--count").count()).toBe(0);
      expect(await page.locator("#sidebar-issues-tab-system .hub-tab__badge--count").count()).toBe(
        0,
      );
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
    }, 720);
  });

  it.each([
    { dismiss: "Escape" as const, name: "Escape" },
    { dismiss: "cancel" as const, name: "Cancel" },
  ])("makes no update request when the operator dismisses with $name", async ({ dismiss }) => {
    await withPage(async (page) => {
      const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);
      await updateButton.click();
      await confirmationDialog(page).waitFor();

      if (dismiss === "Escape") {
        await page.keyboard.press("Escape");
      } else {
        await button(page, "Cancel").click();
      }
      await confirmationDialog(page).waitFor({ state: "detached" });

      expect(await gateway.getRequests("update.run")).toHaveLength(0);
    }, 720);
  });

  it("keeps the update-opening keypress from confirming and lets a later Return confirm once", async () => {
    await withPage(async (page) => {
      const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);

      await updateButton.press("Enter");
      const dialog = confirmationDialog(page);
      await dialog.waitFor();

      // The keypress that opened the dialog lands on Cancel, never on the confirm action.
      const cancel = button(page, "Cancel");
      await expect
        .poll(() => cancel.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(await gateway.getRequests("update.run")).toHaveLength(0);

      const confirm = button(confirmationCopy(page), "Update and restart");
      await confirm.focus();
      await confirm.press("Enter");

      await gateway.waitForRequest("update.run");
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
    }, 720);
  });

  it("sends exactly one update request when the confirm action is clicked", async () => {
    await withPage(async (page) => {
      const { gateway, updateButton } = await openUpdateCard(page, suite.server.baseUrl);
      await updateButton.click();
      await confirmationDialog(page).waitFor();
      const dialogText = await confirmationCopy(page).textContent();
      expect(dialogText).toContain(
        "Installs the available update on the connected Gateway and restarts it.",
      );
      expect(dialogText).toContain("this Control UI disconnects until the Gateway is back");
      expect(dialogText).toContain("Installed v1.0.0 · Available v2.0.0");
      expect(await gateway.getRequests("update.run")).toHaveLength(0);

      await button(confirmationCopy(page), "Update and restart").click();
      await gateway.waitForRequest("update.run");
      await button(confirmationCopy(page), "Updating…").waitFor();
      await confirmationCopy(page).locator("openclaw-update-run-view").waitFor();

      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      await button(page, "Close").click();
      await page.locator(".sidebar-issues-button").click();
      const updateIssue = updateCard(page);
      await updateIssue.locator("summary").click();
      await updateIssue.locator(".sidebar-update-card__action").click();
      await confirmationCopy(page).locator("openclaw-update-run-view").waitFor();
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
    }, 720);
  });

  it("applies the same confirmation to the Settings update row", async () => {
    await withPage(async (page) => {
      const config = { update: { auto: { enabled: false }, channel: "stable" } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.get", "config.set", "update.run"],
        methodResponses: {
          "config.get": {
            config,
            hash: "update-confirmation-1",
            issues: [],
            raw: JSON.stringify(config),
            runtimeConfig: config,
            valid: true,
          },
          "update.run": UPDATE_RUN_RESPONSE,
          "update.runs.get": { run: createUpdateRunFixture() },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
      await gateway.waitForRequest("config.get");
      await gateway.emitGatewayEvent("update.available", { updateAvailable: UPDATE_AVAILABLE });
      await button(page, "Update Gateway…").click();

      const dialog = confirmationDialog(page);
      await dialog.waitFor();
      expect(await confirmationCopy(page).textContent()).toContain(
        "Installed v1.0.0 · Available v2.0.0",
      );
      expect(await gateway.getRequests("update.run")).toHaveLength(0);

      await button(confirmationCopy(page), "Update and restart").click();
      await gateway.waitForRequest("update.run");
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
    });
  });
});
