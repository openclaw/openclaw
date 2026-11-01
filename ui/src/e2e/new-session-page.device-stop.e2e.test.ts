import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { navigationDevice } from "./new-session-page.navigation-fixtures.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  pollText,
  waitForCommittedChatRoute,
  waitForConfirmModal,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("labels device startup and stops only its session, fencing the late dispatch", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const key = "agent:main:device-startup";
      const now = Date.now();
      const placement = {
        state: "requested",
        generation: 1,
        createdAtMs: now,
        updatedAtMs: now,
        stateChangedAtMs: now,
      };
      const session = {
        key,
        sessionId: `session:${key}`,
        label: "Device startup",
        kind: "direct",
        updatedAt: now,
        placement,
      };
      const gateway = await installMockGateway(page, {
        agentModel: "test-provider/test-model",
        models: [{ id: "test-model", name: "Test model", provider: "test-provider" }],
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: [
          "agent.wait",
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          "sessions.dispatch",
          "sessions.reclaim",
        ],
        workspace: "/workspace/project",
        workspaceGit: true,
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "environments.list": {
            environments: [
              {
                ...navigationDevice("paired-runner", "Paired runner"),
                workerSlots: { total: 2, available: 1 },
              },
            ],
            profiles: [],
          },
          "worktrees.branches": LOCAL_GIT_WORKSPACE_RESPONSES["worktrees.branches"],
          "sessions.create": { key },
          "sessions.list": {
            count: 1,
            defaults: {},
            path: "",
            ts: now,
            sessions: [session],
          },
          "sessions.describe": { session: { sessionId: `session:${key}`, placement } },
          "sessions.reclaim": { ok: true },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="device:paired-runner"]').click();
      await page.locator(".new-session-page__message").fill("Run on the paired device");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ agentId: "main", message: "", worktree: true });
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({ key, agentId: "main", deviceId: "paired-runner" });
      await waitForCommittedChatRoute(page);

      const details = await openChatDetails(page);
      await details.locator(".chat-environment__machine-trigger").click();
      const stop = page.locator(".chat-pane__placement-reclaim");
      await stop.waitFor({ state: "visible" });
      const menuText = (await stop.textContent())?.trim();
      await stop.click();
      const workerStopConfirmation = page.locator("openclaw-modal-dialog").filter({
        has: page.locator(".session-worker-stop"),
      });
      const dialog = await waitForConfirmModal(page, workerStopConfirmation);
      expect(menuText).toBe("Stop device worker…");
      expect(
        await dialog.getByRole("heading", { name: "Stop worker?", exact: true }).textContent(),
      ).toBe("Stop worker?");
      expect(await dialog.textContent()).toContain(
        "This will save workspace changes and stop this session’s worker.",
      );
      expect(await dialog.textContent()).toContain("Send a new message to continue.");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await openChatDetails(page);
      await details.locator(".chat-environment__machine-trigger").click();
      await stop.click();
      await (
        await waitForConfirmModal(page, workerStopConfirmation)
      )
        .getByRole("button", { name: "Stop worker", exact: true })
        .click();
      const reclaim = await gateway.waitForRequest("sessions.reclaim");
      expect(reclaim.params).toEqual({ key, agentId: "main" });
      const stopNotice = page.getByRole("alert").filter({ hasText: "Worker stop requested." });
      await pollText(stopNotice).toContain(
        "Worker stop requested. Review the initial message before retrying.",
      );
      await gateway.resolveDeferred("sessions.dispatch", {
        sessionId: `session:${key}`,
        placement: {
          ...placement,
          state: "active",
          generation: 2,
          environmentId: "node:paired-runner",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "base",
          remoteWorkspaceDir: "/workspace/project",
          runner: { kind: "device", status: "available", deviceId: "paired-runner" },
        },
      });
      await pollText(stopNotice).toContain(
        "Worker stop requested. Review the initial message before retrying.",
      );
      expect(await gateway.getRequests("sessions.reclaim")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
    });
  });
});
