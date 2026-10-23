import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../../../src/agents/auth-profiles/persisted.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { expandProvider } from "./model-providers.test-support.ts";

let instance: OpenClawTestInstance;
const key = "synthetic-shared-model-key";
const suite = createControlUiE2eSuite({
  name: "Shared model API keys through Models and CLI",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "shared-model-api-keys",
      reserveIdlePort: false,
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined, NODE_ENV: undefined },
      gatewayArgs: ["--verbose", "--ws-log", "full", "--log-level", "debug"],
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: { model: "fixture/current" },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-original-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "current", name: "Fixture model" }],
            },
          },
        },
        plugins: { allow: [] },
      },
    });
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

async function persistedAuth() {
  const config: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
  return {
    profiles: loadPersistedSharedAuthProfileStore(instance.env)?.profiles ?? {},
    auth: config.auth,
    provider: config.models?.providers?.fixture,
    model: config.agents?.defaults?.model,
  };
}

function authRefreshDiagnostics() {
  return instance
    .logs()
    .split("\n")
    .filter((line) => /models\.authRefresh|request dispatch failed/u.test(line))
    .slice(-20)
    .join("\n");
}

suite.define(() => {
  it("edits and removes a key with identical durable state through Models and CLI", async () => {
    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
    const url = new URL("settings/model-providers", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const observations: unknown[] = [];
    try {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.goto(url.href);
          await waitForControlUiGatewayReady(page);
          const card = await expandProvider(page, "fixture");
          await page.screenshot({ path: path.join(suite.artifactDir, "before-edit.png") });
          await card.getByRole("button", { name: "Set API key" }).click();
          await card.getByLabel("API key", { exact: true }).fill(key);
          await card.getByRole("button", { name: "Save", exact: true }).click();
          await expect.poll(() => card.textContent()).toContain("Secret saved.");
          const saved = await persistedAuth();
          observations.push({ action: "ui-save", state: saved });
          await page.screenshot({ path: path.join(suite.artifactDir, "saved.png") });
          expect(saved.profiles["fixture:manual"]).toMatchObject({
            type: "api_key",
            provider: "fixture",
            key,
          });
          expect(saved.provider?.apiKey).toBe("fixture:manual");
          expect(saved.model).toBe("fixture/current");
          expect(await card.textContent()).not.toContain("could not refresh");

          // Remove provider confirms first, then deletes the saved key.
          await card.getByRole("button", { name: "Remove provider: Fixture", exact: true }).click();
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Remove provider", exact: true })
            .click();
          await expect
            .poll(async () => (await persistedAuth()).profiles["fixture:manual"])
            .toBeUndefined();
          const removed = await persistedAuth();
          observations.push({ action: "ui-remove", state: removed });
          await page.screenshot({ path: path.join(suite.artifactDir, "removed.png") });
          expect(removed.profiles["fixture:manual"]).toBeUndefined();
          expect(removed.provider?.apiKey).toBeUndefined();
          expect(removed.auth?.profiles?.["fixture:manual"]).toBeUndefined();
          expect(removed.model).toBe("fixture/current");

          const authArgs = ["models", "auth"];
          const agentArgs = ["--agent", "main"];
          const args = [...authArgs, "paste-api-key", "--provider", "fixture", ...agentArgs];
          const pasted = spawnSync(process.execPath, ["scripts/run-node.mjs", ...args], {
            env: instance.env,
            input: key,
            encoding: "utf8",
            timeout: 30_000,
          });
          expect(pasted.status, pasted.stderr).toBe(0);
          expect(pasted.stderr, authRefreshDiagnostics()).not.toContain("could not refresh");
          expect(await persistedAuth()).toEqual(saved);
          const logoutArgs = [...authArgs, "logout", "fixture:manual", ...agentArgs, "--yes"];
          const refused = await instance.cli(logoutArgs);
          expect(refused.code, refused.stderr).toBe(1);
          expect(refused.stderr).toContain("stop the Gateway");
          expect(await persistedAuth()).toEqual(saved);

          // CLI logout is offline-only; transfer custody after proving live-owner refusal.
          await instance.stopGateway();
          const loggedOut = await instance.cli(logoutArgs);
          observations.push({
            action: "cli-remove",
            args: logoutArgs,
            ...loggedOut,
            state: await persistedAuth(),
          });
          expect(loggedOut.code, loggedOut.stderr).toBe(0);
          expect(loggedOut.stdout).toContain("Removed auth profile");
          expect(loggedOut.stderr, authRefreshDiagnostics()).not.toContain("could not refresh");
          expect(await persistedAuth()).toEqual(removed);
          await instance.startGateway();
          await page.reload();
          await waitForControlUiGatewayReady(page);
          // With no saved key left, the row offers nothing to remove.
          const summary = card.locator("button.provider-row__summary");
          if ((await summary.count()) > 0) {
            await expandProvider(page, "fixture");
          }
          await expect
            .poll(() =>
              card.getByRole("button", { name: "Remove provider: Fixture", exact: true }).count(),
            )
            .toBe(0);
          await page.screenshot({ path: path.join(suite.artifactDir, "after-cli-removal.png") });
        },
      );
    } finally {
      await fs.writeFile(
        path.join(suite.artifactDir, "observations.json"),
        JSON.stringify(observations, null, 2),
      );
    }
  });
});
