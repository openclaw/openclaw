import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
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
const environment = {
  id: "node:paired-runner",
  type: "node",
  label: "Design laptop",
  status: "available",
  sessionHost: true,
  workerSlots: { total: 2, available: 1 },
};
const folderEnvironment = { ...environment, workerHost: { deviceFolders: true } };
const environments = (
  device: typeof folderEnvironment & { invocableCommands?: string[] } = folderEnvironment,
) => ({ environments: [device], profiles: [] });
const launchResponses = (sessionKey: string) => ({
  "sessions.dispatch": {
    sessionId: `session:${sessionKey}`,
    placement: { state: "active", generation: 1 },
  },
  "chat.send": { runId: "run-device-folder", status: "started" },
});
async function setup(page: Page, scenario: ControlUiMockGatewayScenario) {
  const gateway = await installMockGateway(page, {
    operatorScopes: ["operator.admin", "operator.read", "operator.write"],
    workspace: "/srv/gateway-workspace",
    workspaceGit: false,
    agentModel: "example/worker",
    models: DEVICE_FOLDER_MODELS,
    ...scenario,
  });
  const project = page.locator("#new-session-project-trigger");
  const input = page.getByRole("textbox", { name: "Absolute path on device" });
  const message = page.locator(".new-session-page__message");
  const start = page.getByRole("button", { name: "Start session" });
  await page.goto(`${suite.server.baseUrl}new`);
  await gateway.waitForRequest("environments.list");
  await page.locator("#new-session-where-trigger").click();
  await page.locator('[data-value="device:paired-runner"]').click();
  await project.click();
  return { gateway, project, input, message, start };
}

suite.define(() => {
  it("creates and dispatches an existing folder on exactly the selected capable device", () =>
    suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:existing-device-folder";
      const deviceFolder = { deviceId: "paired-runner", path: "/srv/existing project" };
      const { gateway, project, input, message, start } = await setup(page, {
        methodResponses: {
          "environments.list": { environments: [environment], profiles: [] },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
          ...launchResponses(sessionKey),
        },
      });
      expect(await page.locator('[data-value="device-folder"]').count()).toBe(0);
      await page.keyboard.press("Escape");

      await gateway.setMethodResponse("environments.list", environments());
      const previous = (await gateway.getRequests("environments.list")).length;
      await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "paired-runner" });
      await gateway.waitForRequest("environments.list", { after: previous });
      const model = page.locator('[data-chat-model-select="true"]');
      const selectModel = async (id: "worker" | "remote") => {
        await model.click();
        await selectChatModelOption(page, `example/${id}`);
      };
      await selectModel("remote");
      await project.click();
      const folderChoice = page.locator('[data-value="device-folder"]');
      await expect.poll(() => folderChoice.isDisabled()).toBe(true);
      await expect
        .poll(() => folderChoice.textContent())
        .toContain("Not available with this model");
      await page.keyboard.press("Escape");
      await selectModel("worker");
      await message.fill("Work in the existing device folder");
      await project.click();
      await folderChoice.click();
      const use = page.getByRole("button", { name: "Use this folder" });
      await expect.poll(() => use.isDisabled()).toBe(true);
      await input.fill("relative/folder");
      await expect.poll(() => use.isDisabled()).toBe(true);
      await input.fill(deviceFolder.path);
      await use.click();
      await expect.poll(() => input.isVisible()).toBe(false);
      await expect.poll(() => start.isEnabled()).toBe(true);
      expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
      await selectModel("remote");
      await expect.poll(() => start.isDisabled()).toBe(true);
      await expect
        .poll(() => project.getAttribute("aria-description"))
        .toContain("This model can’t work");
      await message.press("Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await selectModel("worker");
      await expect.poll(() => project.getAttribute("aria-description")).toBe(deviceFolder.path);
      await project.click();
      await folderChoice.click();
      expect(await input.inputValue()).toBe(deviceFolder.path);
      await input.fill("/not-applied");
      await page.keyboard.press("Escape");
      await expect.poll(() => input.isVisible()).toBe(false);
      expect(await project.getAttribute("aria-description")).toBe(deviceFolder.path);
      await expect.poll(() => start.isEnabled()).toBe(true);
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
      expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
        sessionKey,
        sessionId: `session:${sessionKey}`,
        expectedLeafEntryId: null,
        message: "Work in the existing device folder",
      });
    }));
  it("browses folders on the selected device and creates the session in the chosen one", () =>
    suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:browsed-device-folder";
      await page.setViewportSize({ width: 390, height: 844 });
      const home = { path: "/workspace", home: "/workspace", parent: "/Users" };
      const { gateway, input, project, message, start } = await setup(page, {
        featureMethods: [
          "agent.wait",
          "chat.metadata",
          "chat.startup",
          "fs.listDir",
          "sessions.create",
          "sessions.dispatch",
          "worktrees.branches",
        ],
        methodResponses: {
          "environments.list": environments({
            ...folderEnvironment,
            invocableCommands: ["fs.listDir"],
          }),
          "fs.listDir": {
            ...home,
            entries: [{ name: "field-notes", path: "/workspace/field-notes" }],
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
          ...launchResponses(sessionKey),
        },
      });
      await page.getByRole("button", { name: "Existing folder on Design laptop" }).click();
      expect((await gateway.waitForRequest("fs.listDir")).params).toEqual({
        nodeId: "paired-runner",
      });
      await expect
        .poll(() => page.locator(".new-session-page__browser-path").getAttribute("placeholder"))
        .toBe("Design laptop");
      const src = page.getByRole("option", { name: "field-notes" });
      await src.waitFor();
      await gateway.setMethodResponse("fs.listDir", {
        path: "/workspace/field-notes",
        home: "/workspace",
        parent: "/workspace",
        entries: [],
      });
      const listed = (await gateway.getRequests("fs.listDir")).length;
      await src.click();
      expect((await gateway.waitForRequest("fs.listDir", { after: listed })).params).toEqual({
        nodeId: "paired-runner",
        path: "/workspace/field-notes",
      });
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => project.textContent()).toContain("field-notes");
      expect(await input.isVisible()).toBe(false);
      expect(
        await page.getByText("Work in place on the selected device.", { exact: false }).isVisible(),
      ).toBe(false);
      // Gateway checkout probes never run against a path that exists only on the device.
      expect(await gateway.getRequests("worktrees.branches")).toHaveLength(0);
      await message.fill("Plan the catalog review.");
      await start.click();
      expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
        deviceFolder: { deviceId: "paired-runner", path: "/workspace/field-notes" },
      });
    }));
  it("offers device browsing only to admins", () =>
    suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, input, project } = await setup(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "environments.list": environments({
            ...folderEnvironment,
            invocableCommands: ["fs.listDir"],
          }),
        },
      });
      // Writers can apply a path without listing device directories.
      const folderChoice = page.locator('[data-value="device-folder"]');
      await folderChoice.waitFor();
      await folderChoice.click();
      await expect.poll(() => input.evaluate((el) => el === document.activeElement)).toBe(true);
      await input.fill("/workspace/manual");
      const offset = await input.evaluate((field) => {
        const label = field.closest("label")!;
        const text = document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const textStart =
          field.getBoundingClientRect().left +
          Number.parseFloat(getComputedStyle(field).paddingInlineStart);
        return Math.abs(range.getBoundingClientRect().left - textStart);
      });
      expect(offset).toBeLessThanOrEqual(1);
      await input.press("Enter");
      await expect.poll(() => project.textContent()).toContain("manual");
      expect(await gateway.getRequests("fs.listDir")).toHaveLength(0);
    }));
  it("restores a pending device-folder create without changing its device or path", () =>
    suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const deviceFolder = { deviceId: "paired-runner", path: "/srv/existing" };
      const { gateway, input, project, message, start } = await setup(page, {
        deferredMethods: ["sessions.create"],
        workspace: "/srv/gateway",
        methodResponses: {
          "environments.list": environments(),
          "chat.send": { runId: "run-device-folder", status: "started" },
        },
      });
      await page.locator('[data-value="device-folder"]').click();
      await input.fill(deviceFolder.path);
      await input.press("Enter");
      await message.fill("Keep this folder");
      await start.click();
      const first = await gateway.waitForRequest("sessions.create");
      expect(first.params).toMatchObject({ deviceFolder });
      const sessionKey = asRecord(first.params).key;
      if (typeof sessionKey !== "string") {
        throw new Error("Expected the created session key");
      }
      await page.reload();
      await gateway.waitForRequest("environments.list");
      await expect.poll(() => project.getAttribute("aria-description")).toBe(deviceFolder.path);
      await expect
        .poll(() => page.locator("#new-session-where-trigger").getAttribute("data-device-id"))
        .toBe(deviceFolder.deviceId);
      await start.click();
      const retry = await gateway.waitForRequest("sessions.create");
      expect(retry.params).toEqual(first.params);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      await gateway.setMethodResponse("sessions.dispatch", {
        sessionId: `session:${sessionKey}`,
        placement: { state: "active", generation: 1 },
      });
      await gateway.resolveDeferred("sessions.create", { key: sessionKey });
      expect((await gateway.waitForRequest("sessions.dispatch")).params).toMatchObject({
        deviceId: deviceFolder.deviceId,
      });
    }));
});
