import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
  pollAttribute,
} from "./new-session-page.test-support.ts";
const suite = createNewSessionPageE2eSuite();
const desktop = { width: 1280, height: 900 };
const mobile = { width: 393, height: 852 };
async function withPage(
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>,
) {
  const context = await suite.browser.newContext({ viewport, colorScheme: "dark" });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}
const trigger = (page: Page, name: string) => page.locator(`#new-session-${name}-trigger`);
function models(available = true, restoredLabel?: string): ModelCatalogEntry[] {
  const hosted: NonNullable<ModelCatalogEntry["agentRuntime"]> = {
    id: "agentsapi",
    source: "model",
    cloudPlacementSupported: false,
    workspaceEnvironment: {
      kind: "provider-hosted",
      label: restoredLabel ?? "OpenAI (Agents API)",
    },
  };
  const choice: NonNullable<ModelCatalogEntry["runtimeChoices"]>[number] = {
    available,
    agentRuntime: hosted,
    ...(available ? {} : { unavailableReason: "missing-auth" }),
  };
  const model: ModelCatalogEntry = {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    available: true,
    agentRuntime: hosted,
    runtimeChoices: restoredLabel ? [] : [choice],
  };
  if (!restoredLabel) {
    model.agentRuntime = {
      id: "openclaw",
      source: "model",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    };
  }
  return [model];
}
const responses = {
  "environments.list": {
    environments: [],
    profiles: ["aws", "daytona"].map((providerId) => ({
      id: providerId,
      providerId,
      trust: "disposable",
      executionModes: ["worker-turn"],
    })),
  },
  "worktrees.branches": {
    branches: [{ kind: "local", name: "main" }],
    defaultBranch: "main",
    headBranch: "main",
    repositoryStatus: "git",
  },
  "models.list": { models: models() },
  "sessions.create": { key: "agent:main:hosted-proof" },
};
suite.define(() => {
  it("pairs the hosted environment with its runtime and preserves local draft intent on return", () =>
    withPage(desktop, async (page) => {
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
      await openEnvironmentPicker(page);
      const surface = page.locator(".oc-popover.new-session-page__where-popover");
      const option = surface.locator('[data-value="runtime:agentsapi"]');
      await option.waitFor();
      await surface.getByRole("searchbox").fill("Agents API");
      expect(await option.isVisible()).toBe(true);
      await option.focus();
      await page.keyboard.press("Enter");
      const where = trigger(page, "where");
      await pollAttribute(where, "data-hosted-runtime").toBe("agentsapi");
      await where.waitFor();
      expect(await where.textContent()).toContain("OpenAI (Agents API)");
      expect(await trigger(page, "project").count()).toBe(0);
      expect(await trigger(page, "checkout").count()).toBe(0);
      await openEnvironmentPicker(page);
      expect(await option.getAttribute("aria-pressed")).toBe("true");
      await surface.getByRole("searchbox").fill("");
      await surface.locator('[data-value="gateway"]').click();
      await pollAttribute(where, "data-hosted-runtime").toBeNull();
      await trigger(page, "project").waitFor();
      expect(await trigger(page, "project").textContent()).toContain("openclaw");
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
    }));
  it("keeps loading and unavailable hosted choices honest on mobile", () =>
    withPage(mobile, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: "/home/peter/openclaw",
        deferredMethods: ["models.list"],
        methodResponses: responses,
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.locator(".new-session-page__message").waitFor();
      await openEnvironmentPicker(page);
      const picker = page.locator(".oc-popover.new-session-page__where-popover");
      await picker.getByRole("searchbox").fill("Agents API");
      await picker.getByRole("status").waitFor();
      await gateway.resolveDeferred("models.list", { models: models(false) });
      const option = picker.locator('[data-value="runtime:agentsapi"]');
      await pollAttribute(option, "aria-disabled").toBe("true");
      await option.waitFor();
      await option.focus();
      await page.keyboard.press("Enter");
      expect(await trigger(page, "where").getAttribute("data-hosted-runtime")).toBeNull();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    }));
  it("restores the hosted environment from model preferences without exposing local projects", () =>
    withPage(mobile, async (page) => {
      const label = "OpenAI (Agents API) · Research and analysis workspace";
      await installMockGateway(page, {
        workspace: "/home/peter/openclaw",
        workspaceGit: true,
        methodResponses: { ...responses, "models.list": { models: models(true, label) } },
      });
      await page.goto(suite.server.baseUrl + "new");
      const where = trigger(page, "where");
      await pollAttribute(where, "data-hosted-runtime").toBe("agentsapi");
      await where.waitFor();
      expect(await trigger(page, "project").count()).toBe(0);
      expect(await where.getAttribute("aria-label")).toContain(label);
      await openEnvironmentPicker(page);
      expect(
        await page.locator('[data-value="runtime:agentsapi"]').getAttribute("aria-pressed"),
      ).toBe("true");
      expect(await page.locator('[data-value="gateway"]').getAttribute("aria-disabled")).toBe(
        "true",
      );
    }));
});
