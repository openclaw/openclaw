import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";
const suite = createNewSessionPageE2eSuite();
const models: ModelCatalogEntry[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    available: true,
    agentRuntime: {
      id: "openclaw",
      source: "model",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    },
    runtimeChoices: [
      {
        available: true,
        agentRuntime: {
          id: "agentsapi",
          source: "model",
          cloudPlacementSupported: false,
          workspaceEnvironment: { kind: "provider-hosted", label: "OpenAI (Agents API)" },
        },
      },
    ],
  },
];
const responses = {
  "environments.list": {
    environments: [],
    profiles: [
      { id: "aws", providerId: "aws", trust: "disposable", executionModes: ["worker-turn"] },
      {
        id: "daytona",
        providerId: "daytona",
        trust: "disposable",
        executionModes: ["worker-turn"],
      },
    ],
  },
  "worktrees.branches": {
    branches: [{ kind: "local", name: "main" }],
    defaultBranch: "main",
    headBranch: "main",
    repositoryStatus: "git",
  },
  "models.list": { models },
  "sessions.create": { key: "agent:main:hosted-proof" },
};
suite.define(() => {
  it("pairs the hosted environment with its runtime and preserves local draft intent on return", async () => {
    const context = await suite.browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        workspace: "/home/peter/openclaw",
        workspaceGit: true,
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          "sessions.dispatch",
          "environments.list",
          "projects.list",
          "worktrees.branches",
        ],
        methodResponses: responses,
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.locator(".new-session-page__message").waitFor();
      await evaluateControlUiContext(page, (application) => {
        application.theme.setMode("dark");
      });
      await openEnvironmentPicker(page);
      const surface = page.locator("wa-popover.new-session-page__where-popover");
      const option = surface.locator('[data-value="runtime:agentsapi"]');
      await option.waitFor();
      const frame = await takeControlUiScreenshotFrame(
        page,
        surface.locator('wa-popup.popover > [part="popup"]'),
        [surface.getByRole("searchbox", { name: "Search environments" }), option],
        { animations: "disabled", viewport: { width: 1280, height: 900 } },
      );
      await writeFile(path.join(suite.artifactDir, "after.png"), frame.png);
      await surface.getByRole("searchbox").fill("Agents API");
      expect(await option.isVisible()).toBe(true);
      await option.focus();
      await page.keyboard.press("Enter");
      const where = page.locator("#new-session-where-trigger");
      await expect.poll(() => where.getAttribute("data-hosted-runtime")).toBe("agentsapi");
      expect(await where.textContent()).toContain("OpenAI (Agents API)");
      expect(await page.locator("#new-session-project-trigger").count()).toBe(0);
      expect(await page.locator("#new-session-checkout-trigger").count()).toBe(0);
      const selected = await takeControlUiScreenshotFrame(
        page,
        page.locator(".new-session-page__triggers"),
        [where],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "hosted-selected.png"), selected.png);
      await openEnvironmentPicker(page);
      expect(await option.getAttribute("aria-pressed")).toBe("true");
      await surface.getByRole("searchbox").fill("");
      await surface.locator('[data-value="gateway"]').click();
      await expect.poll(() => where.getAttribute("data-hosted-runtime")).toBeNull();
      await page.locator("#new-session-project-trigger").waitFor();
      expect(await page.locator("#new-session-project-trigger").textContent()).toContain(
        "openclaw",
      );
      await openEnvironmentPicker(page);
      await option.click();
      await page.locator(".new-session-page__message").fill("Calculate a small table");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        model: "openai/gpt-5.5",
        agentRuntime: "agentsapi",
        message: "Calculate a small table",
      });
      for (const key of [
        "cwd",
        "projectId",
        "projectGitUrl",
        "repository",
        "worktree",
        "worktreeSource",
        "catalogId",
      ]) {
        expect(create.params).not.toHaveProperty(key);
      }
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
  it("keeps loading and unavailable hosted choices honest on mobile", async () => {
    const context = await suite.browser.newContext({
      viewport: { width: 393, height: 852 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        workspace: "/home/peter/openclaw",
        deferredMethods: ["models.list"],
        methodResponses: responses,
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.locator(".new-session-page__message").waitFor();
      await evaluateControlUiContext(page, (application) => {
        application.theme.setMode("dark");
      });
      await openEnvironmentPicker(page);
      const picker = page.locator("wa-popover.new-session-page__where-popover");
      const surface = picker.locator('wa-popup.popover > [part="popup"]');
      await picker.getByRole("searchbox").fill("Agents API");
      await picker.getByRole("status").waitFor();
      let frame = await takeControlUiScreenshotFrame(page, surface, [picker.getByRole("status")], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "mobile-loading.png"), frame.png);
      const unavailable = models.map((model) => ({
        ...model,
        runtimeChoices: model.runtimeChoices!.map((choice) =>
          Object.assign({}, choice, {
            available: false,
            unavailableReason: "missing-auth",
          }),
        ),
      }));
      await gateway.resolveDeferred("models.list", { models: unavailable });
      const option = picker.locator('[data-value="runtime:agentsapi"]');
      await expect.poll(() => option.getAttribute("aria-disabled")).toBe("true");
      await option.focus();
      await page.keyboard.press("Enter");
      expect(
        await page.locator("#new-session-where-trigger").getAttribute("data-hosted-runtime"),
      ).toBeNull();
      frame = await takeControlUiScreenshotFrame(page, surface, [option], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "mobile-unavailable.png"), frame.png);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
  it("restores the hosted environment from model preferences without exposing local projects", async () => {
    const context = await suite.browser.newContext({
      viewport: { width: 393, height: 852 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    try {
      const label = "OpenAI (Agents API) · Research and analysis workspace";
      const hosted = models[0]!.runtimeChoices![0]!;
      const configured = {
        ...models[0]!,
        agentRuntime: {
          ...hosted.agentRuntime,
          workspaceEnvironment: { kind: "provider-hosted", label },
        },
        runtimeChoices: [],
      };
      await installMockGateway(page, {
        workspace: "/home/peter/openclaw",
        workspaceGit: true,
        methodResponses: { ...responses, "models.list": { models: [configured] } },
      });
      await page.goto(suite.server.baseUrl + "new");
      const trigger = page.locator("#new-session-where-trigger");
      await expect.poll(() => trigger.getAttribute("data-hosted-runtime")).toBe("agentsapi");
      await evaluateControlUiContext(page, (application) => {
        application.theme.setMode("dark");
      });
      expect(await page.locator("#new-session-project-trigger").count()).toBe(0);
      expect(await trigger.getAttribute("aria-label")).toContain(label);
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".new-session-page__triggers"),
        [trigger],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "mobile-restored-long-label.png"), frame.png);
      await openEnvironmentPicker(page);
      expect(
        await page.locator('[data-value="runtime:agentsapi"]').getAttribute("aria-pressed"),
      ).toBe("true");
      expect(await page.locator('[data-value="gateway"]').getAttribute("aria-disabled")).toBe(
        "true",
      );
    } finally {
      await context.close();
    }
  });
});
