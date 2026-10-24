import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:menu-placement";
const label = "Review release notes";
const expectedSource = { generation: 4, environmentId: "worker:notes", ownerEpoch: 7 };
const adminScopes = ["operator.admin", "operator.read", "operator.write"];
const historyMessages = [{ role: "assistant", content: "The release notes are ready for review." }];
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const moveMethods = ["chat.startup", "sessions.move", "environments.list"];
const dispatchMethods = ["chat.startup", "sessions.dispatch", "environments.list"];
const menuItem = (root: Page | Locator, name: string) =>
  root.getByRole("menuitem", { name, exact: true });
async function expectMove(gateway: Gateway, fields: Record<string, unknown>) {
  expect((await gateway.waitForRequest("sessions.move")).params).toEqual({
    key: sessionKey,
    agentId: "main",
    expected: expectedSource,
    ...fields,
  });
}
type MenuFixture = Parameters<typeof installMockGateway>[1] & {
  session?: NonNullable<Parameters<typeof chatSessionListResponse>[0]>[number];
  surface?: Surface;
  locale?: string;
};
function withMenu(
  { session = localSession(), surface = "sidebar", locale, ...overrides }: MenuFixture,
  run: (page: Page, gateway: Gateway) => Promise<void>,
) {
  return suite.withPage(
    { viewport: { width: 1280, height: 900 }, ...(locale ? { locale } : {}) },
    async ({ page }) => {
      const options = {
        featureMethods: moveMethods,
        operatorScopes: adminScopes,
        historyMessages,
        ...overrides,
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        ...options,
        methodResponses: {
          ...(options.featureMethods?.includes("environments.list")
            ? { "environments.list": catalog }
            : {}),
          "sessions.list": chatSessionListResponse([session]),
          ...options.methodResponses,
        },
      });
      await page.goto(
        surface === "sessions"
          ? suite.server.baseUrl + "sessions"
          : controlUiSessionUrl(suite.server.baseUrl, sessionKey),
      );
      await run(page, gateway);
    },
  );
}
function localSession() {
  return {
    key: sessionKey,
    sessionId: "menu-placement-1",
    kind: "direct",
    label,
    updatedAt: Date.now(),
    status: "done",
    hasActiveRun: false,
    worktree: { id: "notes-workspace", branch: "release-notes", repoRoot: "/example/project" },
  };
}
function remoteSession() {
  return {
    ...localSession(),
    placement: {
      state: "active" as const,
      generation: 4,
      createdAtMs: Date.now() - 30_000,
      updatedAtMs: Date.now() - 5_000,
      stateChangedAtMs: Date.now() - 5_000,
      environmentId: "worker:notes",
      activeOwnerEpoch: 7,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "notes-base",
      remoteWorkspaceDir: "/workspace/notes",
    },
  };
}
const catalog = {
  profiles: [{ id: "cloud", providerId: "crabbox", providerDisplayId: "aws" }],
  environments: [
    {
      id: "node:runner",
      type: "node",
      label: "Build device",
      status: "available",
      sessionHost: true,
      workerSlots: { total: 1, available: 1 },
    },
    {
      id: "node:offline",
      type: "node",
      label: "Offline device",
      status: "unavailable",
      sessionHost: true,
    },
  ],
};
type Surface = "sidebar" | "sessions";
async function openMenu(page: Page, surface: Surface) {
  if (surface === "sidebar") {
    const coding = page
      .locator('[data-session-section="work"] .sidebar-session-group-toggle')
      .first();
    if ((await coding.getAttribute("aria-expanded")) === "false") {
      await coding.click();
    }
  }
  const row =
    surface === "sidebar"
      ? page.locator('openclaw-app-sidebar [data-session-key="' + sessionKey + '"]')
      : page.locator("openclaw-sessions-page tr").filter({ hasText: label });
  await row.click({ button: "right" });
  return page.locator("openclaw-session-menu");
}

suite.define(() => {
  it.each(["sidebar", "sessions"] as const)(
    "moves local to remote and back through the %s menu",
    async (surface) => {
      return withMenu(
        {
          surface,
          locale: "en-US",
          featureMethods: [
            "chat.startup",
            "sessions.patch",
            "sessions.dispatch",
            "sessions.move",
            "environments.list",
          ],
        },
        async (page, gateway) => {
          const menu = await openMenu(page, surface);
          const action = menu.getByText("Move to cloud…", { exact: true });
          await action.waitFor();
          await action.click();
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog.locator('[data-value="device:runner"]').waitFor();
          expect(await dialog.locator('[data-value="gateway"]').count()).toBe(0);
          expect(await dialog.locator('[data-value="device:offline"]').isDisabled()).toBe(true);
          await gateway.deferNext("sessions.dispatch");
          const device = surface === "sessions";
          await dialog
            .locator(device ? '[data-value="device:runner"]' : '[data-value="cloud:cloud"]')
            .click();
          await dialog.getByRole("button", { name: "Continue on worker", exact: true }).click();
          const dispatch = await gateway.waitForRequest("sessions.dispatch");
          expect(dispatch.params).toEqual({
            key: sessionKey,
            agentId: "main",
            ...(device ? { deviceId: "runner" } : { profileId: "cloud" }),
          });
          await gateway.setSessionsListResponse(chatSessionListResponse([remoteSession()]));
          await gateway.resolveDeferred("sessions.dispatch", { ok: true });
          await gateway.emitGatewayEvent("sessions.changed", { reason: "dispatch", sessionKey });
          await expect
            .poll(async () => (await gateway.getRequests("sessions.list")).length)
            .toBeGreaterThan(1);
          const reverseMenu = await openMenu(page, surface);
          await reverseMenu.getByText("Move session…", { exact: true }).click();
          await gateway.deferNext("sessions.move");
          await page.locator('[data-value="gateway"]').click();
          await page.getByRole("button", { name: "Move session", exact: true }).click();
          await expectMove(gateway, { target: { kind: "gateway" } });
          await gateway.setSessionsListResponse(chatSessionListResponse([localSession()]));
          await gateway.resolveDeferred("sessions.move", { ok: true });
          expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
          if (surface !== "sessions") {
            expect(page.url()).toContain("menu-placement");
          }
        },
      );
    },
  );

  it("disables Move while workspace results settle and enables it after refresh", async () => {
    const session = remoteSession();
    return withMenu(
      {
        session: {
          ...session,
          placement: { ...session.placement, workspaceResultReconciling: true },
        },
      },
      async (page, gateway) => {
        const menu = await openMenu(page, "sidebar");
        const action = menuItem(menu, "Move session…");
        await action.waitFor();
        expect(await action.isDisabled()).toBe(true);
        expect(await action.getAttribute("title")).toBe("Finalizing worker workspace");
        expect(await gateway.getRequests("sessions.move")).toHaveLength(0);
        await page.keyboard.press("Escape");
        await gateway.setSessionsListResponse(chatSessionListResponse([session]));
        await gateway.emitGatewayEvent("sessions.changed", { reason: "placement", sessionKey });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list")).length)
          .toBeGreaterThan(1);
        await openMenu(page, "sidebar");
        const ready = menuItem(page, "Move session…");
        await expect.poll(() => ready.isDisabled()).toBe(false);
        await ready.click();
        await page.locator('[data-value="gateway"]').click();
        await gateway.deferNext("sessions.move");
        await page.getByRole("button", { name: "Move session", exact: true }).click();
        await expectMove(gateway, { target: { kind: "gateway" } });
        await gateway.resolveDeferred("sessions.move", { ok: true });
      },
    );
  });

  it("keeps a local busy refusal visible without stopping or replaying work", async () => {
    return withMenu(
      {
        featureMethods: dispatchMethods,
        operatorScopes: ["operator.read", "operator.write"],
        historyMessages: undefined,
      },
      async (page, gateway) => {
        const menu = await openMenu(page, "sidebar");
        await menu.getByText("Move to cloud…", { exact: true }).click();
        expect(await page.locator('[data-value="cloud:cloud"]').count()).toBe(0);
        await page.locator('[data-value="device:runner"]').click();
        await gateway.deferNext("sessions.dispatch");
        await page.getByRole("button", { name: "Continue on worker", exact: true }).click();
        await gateway.waitForRequest("sessions.dispatch");
        await gateway.rejectDeferred("sessions.dispatch", {
          code: "UNAVAILABLE",
          message: "Session is busy; wait for the active turn to finish.",
        });
        await page
          .getByText("Session is busy; wait for the active turn to finish.", { exact: false })
          .waitFor();
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(1);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      },
    );
  });
  it("retries the same durable cloud move after a failed retry and reload", async () => {
    const target = {
      kind: "profile" as const,
      profileId: "cloud",
      os: "windows/wsl2",
      machineClass: "fast",
    };
    const retry = {
      expected: expectedSource,
      target,
    };
    const session = {
      ...remoteSession(),
      placement: { ...remoteSession().placement, state: "draining", generation: 5 },
      placementMove: { target, updatedAtMs: 5, error: "Workspace reconciliation failed.", retry },
    };
    return withMenu(
      {
        session,
        featureMethods: ["chat.startup", "sessions.move"],
      },
      async (page, gateway) => {
        await gateway.deferNext("sessions.move");
        await (await openMenu(page, "sidebar")).getByText("Retry move", { exact: true }).click();
        await expectMove(gateway, retry);
        expect(await gateway.getRequests("environments.list")).toHaveLength(0);
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
        await gateway.rejectDeferred("sessions.move", {
          code: "UNAVAILABLE",
          message: "Workspace still cannot be reconciled.",
        });
        await page
          .locator("openclaw-toast-host")
          .getByText("Workspace still cannot be reconciled.", { exact: false })
          .waitFor();
        await page.reload();
        const details = await openChatDetails(page);
        await details.getByRole("button", { name: /Move failed/ }).click();
        await gateway.deferNext("sessions.move");
        const retryAction = menuItem(page, "Retry move");
        await page.getByText("Workspace reconciliation failed.", { exact: true }).waitFor();
        expect(await retryAction.isDisabled()).toBe(false);
        await retryAction.click();
        await expectMove(gateway, retry);
        expect(await gateway.getRequests("environments.list")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.move", { ok: true });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      },
    );
  });
});
