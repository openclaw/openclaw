import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  WORKSPACE,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
  pollAttribute,
  pollEnabled,
  pollText,
  pollDisabled,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const cloudProfile = {
  id: "aws",
  providerId: "crabbox",
  executionMode: "worker-turn",
  executionModes: ["worker-turn"],
  machines: [
    { id: "standard", label: "Standard", default: true },
    { id: "fast", label: "Fast" },
  ],
};
const runtimeModel = (
  id: string,
  name: string,
  provider: string,
  runtime: string,
): ModelCatalogEntry => ({
  id,
  name,
  provider,
  agentRuntime: {
    id: runtime,
    cloudPlacementSupported: true,
    cloudPlacementExecutionMode: runtime === "codex" ? "remote-exec" : "worker-turn",
    source: "model",
  },
});

async function openCloud(scenario: ControlUiMockGatewayScenario = {}) {
  const page = await openPage();
  const gateway = await installMockGateway(page, {
    workspace: WORKSPACE,
    workspaceGit: true,
    ...scenario,
    methodResponses: {
      "environments.list": {
        environments: [],
        profiles: [cloudProfile],
      },
      "worktrees.branches": { branches: [], repositoryStatus: "git" },
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await gateway.waitForRequest("environments.list");
  return { page, gateway };
}

suite.define(() => {
  it.each(["hover", "click"] as const)(
    "keeps cloud machines usable when the picker finishes opening after a profile %s",
    async (input) => {
      const { page } = await openCloud();
      const picker = page.locator(".oc-popover.new-session-page__where-popover");
      await picker.evaluate((element) =>
        (element as HTMLElement).style.setProperty("--oc-overlay-show-duration", "60s"),
      );
      const where = page.locator("#new-session-where-trigger");
      await where.click();
      await expect
        .poll(() => picker.evaluate((element) => element.getAnimations().length))
        .toBeGreaterThan(0);
      await picker.evaluate((element) => {
        for (const animation of element.getAnimations()) {
          animation.pause();
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) - 1;
        }
      });
      await expect
        .poll(() => picker.getByRole("searchbox").evaluate((element) => element.matches(":focus")))
        .toBe(true);
      const profile = picker.locator('[data-value="cloud:aws"]');
      await profile[input]();
      const fast = picker.locator('[data-value="machine:fast"]');
      await fast.waitFor();
      await picker.evaluate((element) =>
        Promise.all(
          element.getAnimations().map((animation) => {
            animation.finish();
            return animation.finished;
          }),
        ),
      );
      if (input === "click") {
        expect(await profile.evaluate((element) => element.matches(":focus"))).toBe(true);
      }
      await fast.click();
      await pollAttribute(where, "data-cloud-profile").toBe("aws");
      await pollAttribute(where, "data-machine-class").toBe("fast");
    },
  );

  it("keeps an explicitly selected cloud destination when its runtime becomes incompatible", async () => {
    const { page, gateway } = await openCloud({
      agentModel: "anthropic/claude-sonnet-4-6",
      models: [
        runtimeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", "openclaw"),
        runtimeModel("gpt-5.6-luna", "GPT-5.6 Luna", "openai", "codex"),
      ],
    });
    await gateway.waitForRequest("models.list");
    const where = page.locator("#new-session-where-trigger");
    const model = page.locator('[data-chat-model-select="true"]');
    const start = page.getByRole("button", { name: "Start session" });
    await openEnvironmentPicker(page);

    const profile = page.locator('[data-value="cloud:aws"]');
    await profile.hover();
    await page.locator('[data-value="machine:fast"]').click();
    await page.keyboard.press("Escape");
    await page.locator(".new-session-page__message").fill("keep this task on the cloud");
    await pollEnabled(start).toBe(true);

    await model.click();
    await selectChatModelOption(page, "openai/gpt-5.6-luna");
    await pollText(model).toContain("GPT-5.6 Luna");
    await pollAttribute(where, "data-cloud-profile").toBe("aws");
    await pollAttribute(where, "data-machine-class").toBe("fast");
    await pollDisabled(start).toBe(true);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);

    await where.click();

    await profile.waitFor();
    await pollDisabled(profile).toBe(true);
    await expect
      .poll(() => tooltipTitleText(profile))
      .toBe(
        "Cloud worker provider: crabbox, The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
      );
    await page.keyboard.press("Escape");

    await model.click();
    await selectChatModelOption(page, "anthropic/claude-sonnet-4-6");
    await pollAttribute(where, "data-cloud-profile").toBe("aws");
    await pollAttribute(where, "data-machine-class").toBe("fast");
    await pollEnabled(start).toBe(true);
  });
});
