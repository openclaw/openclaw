import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activationFailure,
  button,
  candidate,
  expectRequestCounts,
  makeDetection,
  runningStep,
  runningWizard,
  setupContext,
  setupPages,
  setupRpc as rpc,
  waitText,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Explicit AI onboarding",
  startServerBeforeBrowser: true,
});
const withPage = setupPages(suite, () => setupContext({ viewport: { width: 1080, height: 850 } }));
const detection = makeDetection({
  candidates: [
    candidate("codex-cli", "Codex", "openai/gpt-5", { recommended: true }),
    candidate("anthropic-api-key", "Anthropic", "anthropic/claude-sonnet-4-6"),
  ],
  authOptions: [
    { id: "meta-api-key", label: "Meta", kind: "install", featured: false },
    { id: "custom-api-key", label: "Custom compatible endpoint", kind: "custom", featured: false },
  ],
  nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
  nativeSessionCatalogPreferenceRequired: true,
  setupComplete: false,
});

suite.define(() => {
  it("requires an explicit choice after discovery and rescan, preserving activation failures", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [rpc.detect, rpc.activate, rpc.auth, rpc.next],
        methodResponses: {
          [rpc.detect]: detection,
          [rpc.activate]: activationFailure(
            "HTTP 401: review this provider credential and try again.",
            "auth",
          ),
        },
      });
      await page.goto(suite.server.baseUrl + "settings/model-setup?firstRun=explicit");
      await page.getByRole("heading", { name: "Found on this Gateway" }).waitFor();
      expect(await page.getByLabel("Show existing native conversations").isChecked()).toBe(false);
      expect(await page.locator("openclaw-model-setup-page [data-selected]").count()).toBe(0);
      await button(page, "Check again").click();
      await gateway.waitForRequest(rpc.detect, { after: 1 });
      await page.getByRole("heading", { name: "Found on this Gateway" }).waitFor();
      await expectRequestCounts(gateway, {
        [rpc.activate]: 0,
        [rpc.auth]: 0,
        "plugins.install": 0,
        [rpc.verify]: 0,
        "config.set": 0,
        "config.patch": 0,
        "config.apply": 0,
      });
      await page.locator('[data-candidate-kind="anthropic-api-key"] button').click();
      expect((await gateway.waitForRequest(rpc.activate)).params).toMatchObject({
        kind: "anthropic-api-key",
        nativeSessionCatalogsEnabled: false,
      });
      await waitText(page, "HTTP 401: review this provider credential and try again.", false);
      expect(await gateway.getRequests(rpc.activate)).toHaveLength(1);
    });
  });

  it("starts installation only after a click and waits for capability consent with native discovery opted in", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installSetupGateway(page, {
        featureMethods: [rpc.detect, rpc.auth, rpc.next, rpc.cancel],
        methodResponses: {
          [rpc.detect]: detection,
          [rpc.auth]: runningWizard(),
          [rpc.next]: runningStep(
            "meta-capabilities",
            "confirm",
            "Accept Meta provider capabilities?",
            { initialValue: false },
          ),
          [rpc.cancel]: { status: "cancelled" },
        },
      });
      await openModelSetup(page, suite.server.baseUrl);
      const install = page.locator('[data-auth-choice="meta-api-key"] button');
      await install.waitFor();
      await expectRequestCounts(gateway, { [rpc.auth]: 0, [rpc.next]: 0 });
      await page.getByLabel("Show existing native conversations").check();
      await install.click();
      expect((await gateway.waitForRequest(rpc.auth)).params).toMatchObject({
        agentId: "main",
        authChoice: "meta-api-key",
        nativeSessionCatalogsEnabled: true,
      });
      const dialog = page.locator("openclaw-modal-dialog");
      await waitText(dialog, "Accept Meta provider capabilities?");
      const pending = await gateway.getRequests(rpc.next);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.params).not.toHaveProperty("answer");
      await button(dialog, "Cancel").click();
      await gateway.waitForRequest(rpc.cancel);
      expect(await gateway.getRequests(rpc.auth)).toHaveLength(1);
    });
  });

  it("keeps a remote custom-endpoint diagnostic selectable and copyable without advancing the wizard", async () => {
    await withPage(
      async ({ page }) => {
        const diagnosticText =
          "Run openclaw onboard on the Gateway host to configure this custom endpoint.";
        const gateway = await installSetupGateway(page, {
          featureMethods: [rpc.detect, rpc.auth, rpc.next],
          methodResponses: {
            [rpc.detect]: detection,
            [rpc.auth]: activationFailure(diagnosticText, "unavailable"),
          },
        });
        await openModelSetup(page, suite.server.baseUrl);
        await page.locator('[data-auth-choice="custom-api-key"] button').click();
        expect((await gateway.waitForRequest(rpc.auth)).params).toMatchObject({
          authChoice: "custom-api-key",
          agentId: "main",
        });
        const dialog = page.locator("openclaw-modal-dialog");
        const alert = dialog.getByRole("alert");
        await alert.waitFor();
        const diagnostic = alert.getByText(diagnosticText, { exact: true });
        await diagnostic.waitFor();
        expect(
          await diagnostic.evaluate((element) => {
            const { userSelect, overflowY } = getComputedStyle(element);
            return { userSelect, overflowY };
          }),
        ).toEqual({ userSelect: "text", overflowY: "auto" });
        await button(alert, "Copy").click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(diagnosticText);
        expect(await dialog.locator("details").count()).toBe(0);
        await expectRequestCounts(gateway, { [rpc.next]: 0, [rpc.auth]: 1 });
      },
      { permissions: ["clipboard-read", "clipboard-write"] },
    );
  });
});
