import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  localModelName,
  loginOrigin,
  loginProvider,
  startProviderBrowserLoginFixture,
} from "./provider-browser-login.test-support.ts";

// First run: the agent has no model, only an available local one (like a running llama.cpp).
// One browser sign-in must end in a chat that answers, with every screen telling the truth.
let fixture: Awaited<ReturnType<typeof startProviderBrowserLoginFixture>>;
const browserArgs: string[] = [];
const suite = createControlUiE2eSuite({
  name: "First browser sign-in selects a model and starts a chat",
  startServerBeforeBrowser: true,
  browserLaunchOptions: { args: browserArgs },
  async startServer() {
    fixture = await startProviderBrowserLoginFixture({ firstRun: true });
    browserArgs.push(
      `--host-resolver-rules=MAP files.proxy.test:443 127.0.0.1:${fixture.edgePort}`,
      "--no-proxy-server",
    );
    return {
      baseUrl: fixture.baseUrl,
      close: () =>
        runQaGatewayFixture(
          () => fs.writeFile(path.join(suite.artifactDir, "gateway.log"), fixture.instance.logs()),
          () => fixture.close(),
        ),
    };
  },
});

suite.define(() => {
  it("names the selected model at once, sets the agent primary, and the starter chat answers", async () => {
    const loginLabel = "Fixture browser sign-in";
    const modelName = "Signed-in fixture model";
    const primary = async () => {
      const config: OpenClawConfig = JSON.parse(
        await fs.readFile(fixture.instance.configPath, "utf8"),
      );
      // The agent's own model wins over defaults, as the Gateway routes it.
      const entries = config.agents?.entries as Record<string, { model?: unknown }> | undefined;
      const model = entries?.main?.model ?? config.agents?.defaults?.model;
      return typeof model === "string"
        ? model
        : (model as { primary?: string } | undefined)?.primary;
    };
    expect(await primary()).toBeUndefined();
    await suite.withPage(
      {
        ignoreHTTPSErrors: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page, context }) => {
        await page.goto(`${loginOrigin}/settings/model-providers`);
        const secret = page.getByLabel("Gateway secret", { exact: true });
        await secret.waitFor();
        await secret.fill(fixture.instance.gatewayToken);
        await page.locator(".login-gate__connect").click();
        await page.locator('[data-kind="pairing-required"]').waitFor();
        const devices = await fixture.instance.cli(["devices", "list", "--json"]);
        expect(devices.code, devices.stderr).toBe(0);
        const pending = JSON.parse(devices.stdout).pending;
        expect(pending).toHaveLength(1);
        const approved = await fixture.instance.cli(["devices", "approve", pending[0].requestId]);
        expect(approved.code, approved.stderr).toBe(0);
        await waitForControlUiGatewayReady(page);

        // The available local model is listed, but it is not the agent's choice.
        const listed = await fixture.instance.cli([
          "gateway",
          "call",
          "models.list",
          "--json",
          "--params",
          JSON.stringify({ agentId: "main" }),
        ]);
        expect(listed.code, listed.stderr).toBe(0);
        expect(JSON.parse(listed.stdout).models).toContainEqual(
          expect.objectContaining({ name: localModelName, available: true }),
        );
        const readiness = page.locator('[data-model-readiness="model-required"]');
        await readiness.waitFor();
        await readiness.locator("[data-models-connect]").click();
        await page.locator(`[data-models-login-provider="${loginProvider}"]`).click();
        const modal = page.locator("openclaw-modal-dialog");
        await modal.getByRole("button", { name: loginLabel, exact: true }).click();
        const link = page.locator(".wizard-step__external-link");
        await link.waitFor();
        const popup = context.waitForEvent("page");
        await link.click();
        const providerPage = await popup;
        await providerPage.getByRole("button", { name: "Approve sign-in" }).click();

        // The ready dialog names the model and offers the starter in the same render.
        await modal.getByRole("heading", { name: `${loginLabel} is ready`, exact: true }).waitFor();
        await modal.getByText(`${modelName} is ready for your agent.`, { exact: true }).waitFor({
          timeout: 1_000,
        });
        const starter = modal.getByRole("button", {
          name: `Start a new chat with ${modelName}`,
          exact: true,
        });
        await starter.waitFor({ timeout: 1_000 });
        // Selected with the account that just signed in.
        expect(await primary()).toBe(`${loginProvider}/ready@${loginProvider}:default`);

        await starter.click();
        await page.waitForURL(/\/chat/u);
        const composer = page.locator("textarea").first();
        await composer.waitFor();
        await composer.fill("Write a limerick about OpenClaw.");
        await composer.press("Enter");
        await page.getByText("Signed-in fixture reply").first().waitFor({ timeout: 30_000 });
        const body = (await page.locator("body").textContent()) ?? "";
        expect(body).not.toContain("Set up a model");
        expect(body).not.toContain("Couldn't load models from openai");
        expect(body).not.toContain("Couldn’t load models from openai");
        expect(fixture.requests).toContain("/chat/completions");
      },
    );
  }, 120_000);
});
