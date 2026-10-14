import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const DEVICE_FOLDER_MODELS = ["worker", "remote"].map<ModelCatalogEntry>((id) => ({
  id,
  name: id === "worker" ? "Worker model" : "Remote model",
  provider: "example",
  available: true,
  agentRuntime: {
    id: id === "worker" ? "openclaw" : "remote",
    source: "model",
    cloudPlacementSupported: true,
    cloudPlacementExecutionMode: id === "worker" ? "worker-turn" : "remote-exec",
    devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: id === "worker" },
  },
}));

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("creates and dispatches an existing folder on exactly the selected capable device", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:existing-device-folder";
      const deviceFolder = { deviceId: "paired-runner", path: "/srv/existing project" };
      const environment = {
        id: "node:paired-runner",
        type: "node",
        label: "Paired runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 2, available: 1 },
      };
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        workspace: "/srv/gateway-workspace",
        workspaceGit: false,
        agentModel: "example/worker",
        models: DEVICE_FOLDER_MODELS,
        methodResponses: {
          "environments.list": { environments: [environment], profiles: [] },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
          "sessions.dispatch": { placement: { state: "active", generation: 1 } },
          "sessions.send": { runId: "run-device-folder", status: "started" },
        },
      });
      const proofDir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("device-folder")
          : undefined;
      const capture = async (name: string) => {
        if (!proofDir) {
          return;
        }
        const surface = page.locator(".new-session-page__triggers");
        const frame = await takeControlUiScreenshotFrame(
          page,
          surface,
          [page.locator("#new-session-project-trigger")],
          { animations: "disabled" },
        );
        await writeFile(path.join(proofDir, name), frame.png);
      };
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="device:paired-runner"]').click();
      await page.locator("#new-session-project-trigger").click();
      expect(await page.locator('[data-value="device-folder"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await capture("before-no-device-folder.png");

      await gateway.setMethodResponse("environments.list", {
        environments: [{ ...environment, workerHost: { deviceFolders: true } }],
        profiles: [],
      });
      const previous = (await gateway.getRequests("environments.list")).length;
      await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "paired-runner" });
      await gateway.waitForRequest("environments.list", { after: previous });
      const model = page.locator('[data-chat-model-select="true"]');
      const selectModel = async (id: "worker" | "remote") => {
        await model.click();
        await selectChatModelOption(page.locator(`[data-chat-model-option="example/${id}"]`));
      };
      await selectModel("remote");
      await page.locator("#new-session-project-trigger").click();
      const folderChoice = page.locator('[data-value="device-folder"]');
      await expect.poll(() => folderChoice.isDisabled()).toBe(true);
      await expect.poll(() => folderChoice.textContent()).toContain("worker-turn runtime");
      await page.keyboard.press("Escape");
      await selectModel("worker");
      await page.locator("#new-session-project-trigger").click();
      await folderChoice.click();
      const input = page.getByRole("textbox", { name: "Absolute path on device" });
      await input.waitFor();
      await page.locator(".new-session-page__message").fill("Work in the existing device folder");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await input.fill("relative/folder");
      await expect.poll(() => start.isDisabled()).toBe(true);
      await input.fill(deviceFolder.path);
      await expect.poll(() => start.isEnabled()).toBe(true);
      expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
      await selectModel("remote");
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await input.inputValue()).toBe(deviceFolder.path);
      await expect
        .poll(() => page.locator(".new-session-page__device-folder").textContent())
        .toContain("worker-turn runtime");
      await page.locator(".new-session-page__message").press("Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await capture("after-incompatible-runtime.png");
      await selectModel("worker");
      expect(await input.inputValue()).toBe(deviceFolder.path);
      await expect.poll(() => start.isEnabled()).toBe(true);
      await capture("after-device-folder-desktop.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page
            .locator(".new-session-page__device-folder")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
      await capture("after-device-folder-mobile.png");
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ agentId: "main", message: "", deviceFolder });
      for (const field of [
        "worktree",
        "worktreeSource",
        "repository",
        "cwd",
        "projectId",
        "projectGitUrl",
        "worktreeBaseRef",
        "worktreeName",
        "execNode",
      ]) {
        expect(create.params).not.toHaveProperty(field);
      }
      expect((await gateway.waitForRequest("sessions.dispatch")).params).toEqual({
        key: sessionKey,
        agentId: "main",
        deviceId: deviceFolder.deviceId,
      });
      expect((await gateway.waitForRequest("sessions.send")).params).toMatchObject({
        key: sessionKey,
        message: "Work in the existing device folder",
      });
    });
  });
  it("restores a pending device-folder create without changing its device or path", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const deviceFolder = { deviceId: "paired-runner", path: "/srv/existing" };
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        deferredMethods: ["sessions.create"],
        workspace: "/srv/gateway",
        workspaceGit: false,
        agentModel: "example/worker",
        models: DEVICE_FOLDER_MODELS,
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "node:paired-runner",
                type: "node",
                label: "Paired runner",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 2, available: 1 },
                workerHost: { deviceFolders: true },
              },
            ],
            profiles: [],
          },
          "sessions.dispatch": { placement: { state: "active", generation: 1 } },
          "sessions.send": { runId: "run-recovered-folder", status: "started" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      await page.locator('[data-value="device:paired-runner"]').click();
      await page.locator("#new-session-project-trigger").click();
      await page.locator('[data-value="device-folder"]').click();
      await page.getByRole("textbox", { name: "Absolute path on device" }).fill(deviceFolder.path);
      await page.locator(".new-session-page__message").fill("Keep this folder");
      await page.getByRole("button", { name: "Start session" }).click();
      const first = await gateway.waitForRequest("sessions.create");
      expect(first.params).toMatchObject({ deviceFolder });
      if (
        !first.params ||
        typeof first.params !== "object" ||
        !("key" in first.params) ||
        typeof first.params.key !== "string"
      ) {
        throw new Error("Expected a keyed session create request");
      }
      const sessionKey = first.params.key;
      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect
        .poll(() => page.getByRole("textbox", { name: "Absolute path on device" }).inputValue())
        .toBe(deviceFolder.path);
      await expect
        .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-device-id"))
        .toBe(deviceFolder.deviceId);
      await page.getByRole("button", { name: "Start session" }).click();
      const retry = await gateway.waitForRequest("sessions.create");
      expect(retry.params).toEqual(first.params);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.create", { key: sessionKey });
      expect((await gateway.waitForRequest("sessions.dispatch")).params).toMatchObject({
        deviceId: deviceFolder.deviceId,
      });
    });
  });
});
