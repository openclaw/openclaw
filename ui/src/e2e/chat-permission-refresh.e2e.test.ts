import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { ControlUiMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };
type PermissionTestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

suite.define(() => {
  it("keeps a saved permission mode when its list refresh fails", async () => {
    const artifacts = createControlUiE2eArtifactDir("chat-permission-refresh");
    await suite.withPage(
      createControlUiE2eContextOptions(),
      async ({ page }) => {
        const session = {
          key: "agent:main:permission-refresh",
          kind: "direct",
          label: "Permission refresh",
          permissionMode: "guarded",
          sessionId: "permission-refresh-generation",
          updatedAt: 1,
        };
        const gateway = await installMockGateway(page, {
          sessions: [session],
          methodResponses: {
            "sessions.list": {
              cases: [{ match: { spawnedBy: session.key }, response: chatSessionListResponse([]) }],
            },
          },
          sessionKey: session.key,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const trigger = pane.locator('[data-chat-permission-select="true"]');
        await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("guarded");
        const patchMatch = { key: session.key, permissionMode: "workspace" };
        await gateway.deferNext("sessions.patch", patchMatch);

        await trigger.click();
        await pane.locator('[data-chat-permission-option="workspace"]').click();
        await gateway.waitForRequest("sessions.patch", { match: patchMatch });
        // Hydration can observe the old permission while its write is still pending.
        await page.evaluate(async () => {
          const app = document.querySelector("openclaw-app") as PermissionTestApp;
          await app.runtime?.context.sessions.list({ agentId: "main" });
        });
        const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
        await gateway.deferNext("sessions.list", rosterMatch);
        await gateway.resolveDeferred("sessions.patch");
        await gateway.waitForRequest("sessions.list", { after: listRequests, match: rosterMatch });
        // Swarm hydration can finish here; the parent must not appear in its own child query.
        await page.evaluate(async (key) => {
          const app = document.querySelector("openclaw-app") as PermissionTestApp;
          await app.runtime?.context.sessions.list({
            spawnedBy: key,
            includeGlobal: false,
            includeUnknown: false,
            configuredAgentsOnly: true,
            limit: 10_000,
          });
        }, session.key);
        await gateway.rejectDeferred("sessions.list", {
          code: "UNAVAILABLE",
          message: "Roster refresh unavailable",
        });

        await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("workspace");
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await pane
          .locator(".chat-error")
          .getByText("Permissions were saved", { exact: false })
          .waitFor();
        await pane
          .locator(".chat-error")
          .getByText("Roster refresh unavailable", { exact: false })
          .waitFor();
      },
      async ({ page }) => {
        await page.screenshot({ path: `${artifacts}/final-state.png` });
      },
    );
  });

  it("keeps a newer permission event after an older patch response arrives", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const session = {
      key: "agent:main:permission-ordering",
      kind: "direct",
      label: "Permission ordering",
      permissionMode: "guarded",
      sessionId: "permission-ordering-generation",
      updatedAt: 1,
    };
    const gateway = await installMockGateway(page, {
      sessions: [session],
      methodResponses: {
        "sessions.list": {
          cases: [{ match: { spawnedBy: session.key }, response: chatSessionListResponse([]) }],
        },
      },
      sessionKey: session.key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const trigger = pane.locator('[data-chat-permission-select="true"]');
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("guarded");
      const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      const patchMatch = { key: session.key, permissionMode: "workspace" };
      await gateway.deferNext("sessions.patch", patchMatch);

      await trigger.click();
      await pane.locator('[data-chat-permission-option="workspace"]').click();
      await gateway.waitForRequest("sessions.patch", { match: patchMatch });
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        ...session,
        sessionKey: session.key,
        reason: "patch",
        permissionMode: "full",
        updatedAt: 3,
      });
      await expect
        .poll(() =>
          page.evaluate((key) => {
            const app = document.querySelector("openclaw-app") as PermissionTestApp;
            return app.runtime?.context.sessions.state.result?.sessions.find(
              (row) => row.key === key,
            )?.permissionMode;
          }, session.key),
        )
        .toBe("full");
      await gateway.waitForRequest("sessions.list", { after: listRequests, match: rosterMatch });
      await gateway.resolveDeferred("sessions.patch", {
        key: session.key,
        entry: {
          permissionMode: "workspace",
          sessionId: session.sessionId,
          updatedAt: 2,
        },
      });

      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("full");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(
        listRequests + 1,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("settles permission patches before reflecting changes and observes remote updates", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const session = {
      key: "agent:main:session-a",
      kind: "direct",
      label: "Session A",
      permissionMode: "guarded",
      sessionId: "session-a-original",
      sessionRoot: "/workspace/projects/openclaw",
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      sessionKey: session.key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const trigger = pane.locator('[data-chat-permission-select="true"]');
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      expect(await trigger.getAttribute("data-chat-select-value")).toBe("guarded");
      expect(
        await trigger.evaluate((element) => element.closest(".agent-chat__composer-meta") != null),
      ).toBe(true);
      expect(
        await trigger.evaluate(
          (element) => element.closest(".chat-composer-model-control") != null,
        ),
      ).toBe(false);

      const firstListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await trigger.click();
      const firstOption = pane.locator('[data-chat-permission-option="default"]');
      await firstOption.waitFor({ state: "visible" });
      const [triggerBox, firstOptionBox] = await Promise.all([
        trigger.boundingBox(),
        firstOption.boundingBox(),
      ]);
      expect(triggerBox).not.toBeNull();
      expect(firstOptionBox).not.toBeNull();
      if (!triggerBox || !firstOptionBox) {
        throw new Error("expected permission picker geometry");
      }
      expect(firstOptionBox.y + firstOptionBox.height).toBeLessThanOrEqual(triggerBox.y - 1);
      expect(firstOptionBox.x).toBeGreaterThanOrEqual(triggerBox.x);
      expect(firstOptionBox.x - triggerBox.x).toBeLessThanOrEqual(32);
      await pane.locator('[data-chat-permission-option="workspace"]').click();
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        expectedSessionId: session.sessionId,
        key: session.key,
        permissionMode: "workspace",
      });
      await waitForRequests(gateway, "sessions.list", firstListCount + 1, rosterMatch);

      // Later patch acknowledgements read canonical state, not injected wire snapshots.
      const workspaceList = chatSessionListResponse([
        { ...session, permissionMode: "workspace", updatedAt: 3 },
      ]);
      await gateway.setSessionsListResponse(workspaceList);
      // Snapshot and emit in one browser turn so an earlier request cannot satisfy this event.
      const workspaceEventListCount = await page.evaluate(
        ({ session: eventSession, match }) => {
          const mockGateway = (
            window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
          ).openclawControlUiE2eGateway;
          if (!mockGateway) {
            throw new Error("Mock Gateway is not installed");
          }
          const count = mockGateway.findRequests("sessions.list", match).length;
          mockGateway.emit("sessions.changed", {
            ...eventSession,
            permissionMode: "workspace",
            reason: "patch",
            sessionKey: eventSession.key,
            updatedAt: 3,
          });
          return count;
        },
        { session, match: rosterMatch },
      );
      await gateway.resolveDeferred("sessions.list", workspaceList);
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("workspace");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await trigger.textContent()).toContain("Workspace");

      // Admit this event's refresh before measuring the next mutation's own roster request.
      await waitForRequests(gateway, "sessions.list", workspaceEventListCount + 1, rosterMatch);
      const secondListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await trigger.click();
      await pane.locator('[data-chat-permission-option="default"]').click();
      const patchRequests = await waitForRequests(gateway, "sessions.patch", 2);
      expect(requireRecord(patchRequests[1]?.params)).toMatchObject({
        key: session.key,
        permissionMode: null,
      });
      await waitForRequests(gateway, "sessions.list", secondListCount + 1, rosterMatch);

      const defaultList = chatSessionListResponse([
        { ...session, permissionMode: undefined, updatedAt: 4 },
      ]);
      await gateway.setSessionsListResponse(defaultList);
      await gateway.emitGatewayEvent("sessions.changed", {
        ...session,
        permissionMode: null,
        reason: "patch",
        sessionKey: session.key,
        updatedAt: 4,
      });
      await gateway.resolveDeferred("sessions.list", defaultList);
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("");
      expect(await trigger.textContent()).toContain("Default");

      // A rejection still belongs to this pane while its physical session remains current.
      await gateway.deferNext("sessions.patch");
      await trigger.click();
      await pane.locator('[data-chat-permission-option="full"]').click();
      const currentPatch = (await waitForRequests(gateway, "sessions.patch", 3))[2];
      expect(requireRecord(currentPatch?.params)).toMatchObject({
        expectedSessionId: session.sessionId,
        key: session.key,
        permissionMode: "full",
      });
      await gateway.rejectDeferred("sessions.patch", {
        code: "UNAVAILABLE",
        message: "Permission update could not be applied",
      });
      await pane
        .locator(".chat-error")
        .getByText("Failed to update permissions", { exact: false })
        .waitFor();
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("");
      await expect.poll(() => trigger.isEnabled()).toBe(true);

      await gateway.deferNext("sessions.patch");
      await trigger.click();
      await pane.locator('[data-chat-permission-option="full"]').click();
      const stalePatch = (await waitForRequests(gateway, "sessions.patch", 4))[3];
      expect(requireRecord(stalePatch?.params)).toMatchObject({
        expectedSessionId: session.sessionId,
        key: session.key,
        permissionMode: "full",
      });
      const replacement = {
        ...session,
        permissionMode: "read-only",
        sessionId: "session-after-replacement",
        updatedAt: 5,
      };
      const replacementList = chatSessionListResponse([replacement]);
      await gateway.setSessionsListResponse(replacementList);
      const recoveryListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        message: "session identity changed; refresh and retry",
      });
      await waitForRequests(gateway, "sessions.list", recoveryListCount + 1, rosterMatch);
      await gateway.resolveDeferred("sessions.list", replacementList);

      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("read-only");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await pane.locator(".chat-error").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
