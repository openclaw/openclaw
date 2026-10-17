import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
async function capture(
  page: Page,
  name: string,
  surface: Locator,
  content: Locator[],
  viewport?: { width: number; height: number },
) {
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    animations: "disabled",
    ...(viewport ? { viewport } : {}),
  });
  await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
}
async function darkTheme(page: Page) {
  await evaluateControlUiContext(page, (application) => application.theme.setMode("dark"));
}
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
    await withPage(desktop, async (page) => {
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
      await darkTheme(page);
      await openEnvironmentPicker(page);
      const surface = page.locator(".oc-popover.new-session-page__where-popover");
      const option = surface.locator('[data-value="runtime:agentsapi"]');
      await option.waitFor();
      await capture(
        page,
        "after",
        surface,
        [surface.getByRole("searchbox", { name: "Search environments" }), option],
        desktop,
      );
      await surface.getByRole("searchbox").fill("Agents API");
      expect(await option.isVisible()).toBe(true);
      await option.focus();
      await page.keyboard.press("Enter");
      const where = trigger(page, "where");
      await pollAttribute(where, "data-hosted-runtime").toBe("agentsapi");
      expect(await where.textContent()).toContain("OpenAI (Agents API)");
      expect(await trigger(page, "project").count()).toBe(0);
      expect(await trigger(page, "checkout").count()).toBe(0);
      await capture(page, "hosted-selected", page.locator(".new-session-page__triggers"), [where]);
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
    });
  });
  it("keeps loading and unavailable hosted choices honest on mobile", async () => {
    await withPage(mobile, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: "/home/peter/openclaw",
        deferredMethods: ["models.list"],
        methodResponses: responses,
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.locator(".new-session-page__message").waitFor();
      await darkTheme(page);
      await openEnvironmentPicker(page);
      const picker = page.locator(".oc-popover.new-session-page__where-popover");
      await picker.getByRole("searchbox").fill("Agents API");
      await picker.getByRole("status").waitFor();
      await capture(page, "mobile-loading", picker, [picker.getByRole("status")]);
      const unavailable = models.map((model) => ({
        ...model,
        runtimeChoices: model.runtimeChoices!.map((choice) =>
          Object.assign({}, choice, { available: false, unavailableReason: "missing-auth" }),
        ),
      }));
      await gateway.resolveDeferred("models.list", { models: unavailable });
      const option = picker.locator('[data-value="runtime:agentsapi"]');
      await pollAttribute(option, "aria-disabled").toBe("true");
      await option.focus();
      await page.keyboard.press("Enter");
      expect(await trigger(page, "where").getAttribute("data-hosted-runtime")).toBeNull();
      await capture(page, "mobile-unavailable", picker, [option]);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });
  it("restores the hosted environment from model preferences without exposing local projects", async () => {
    await withPage(mobile, async (page) => {
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
      const where = trigger(page, "where");
      await pollAttribute(where, "data-hosted-runtime").toBe("agentsapi");
      await darkTheme(page);
      expect(await trigger(page, "project").count()).toBe(0);
      expect(await where.getAttribute("aria-label")).toContain(label);
      await capture(
        page,
        "mobile-restored-long-label",
        page.locator(".new-session-page__triggers"),
        [where],
      );
      await openEnvironmentPicker(page);
      expect(
        await page.locator('[data-value="runtime:agentsapi"]').getAttribute("aria-pressed"),
      ).toBe("true");
      expect(await page.locator('[data-value="gateway"]').getAttribute("aria-disabled")).toBe(
        "true",
      );
    });
  });
});
