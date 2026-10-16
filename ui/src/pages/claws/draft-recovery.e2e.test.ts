import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const capture = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!canRunPlaywrightChromium(executablePath))("Claw draft conflict recovery", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps local edits on cancel and reloads the latest draft only after confirming discard", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const config = { gateway: { controlUi: { experimental: { claws: true } } } };
    const initial = { content: '{"name":"release-notes"}', revision: "a".repeat(64) };
    const latest = { content: '{"name":"agent-revised"}', revision: "b".repeat(64) };
    const local = '{"name":"local-edit"}';
    const gateway = await installMockGateway(page, {
      featureMethods: ["claws.drafts.create", "claws.drafts.read", "claws.drafts.save"],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          resolved: config,
          raw: JSON.stringify(config),
          hash: "draft-config",
          valid: true,
          issues: [],
        },
        "claws.drafts.read": initial,
      },
    });
    try {
      await page.goto(
        `${server.baseUrl}agents/claws?draft=ec8f46b0-4ca3-4991-8a73-dfdcc8764087&agent=main`,
      );
      const editor = page.getByRole("textbox", { name: "Draft document (JSON)" });
      await editor.waitFor();
      await editor.fill(local);
      await gateway.deferNext("claws.drafts.save");
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      await gateway.waitForRequest("claws.drafts.save");
      await gateway.rejectDeferred("claws.drafts.save", {
        code: "INVALID_REQUEST",
        message: "The draft changed or could not be safely saved. Reload it before saving again.",
      });
      await page.getByRole("alert").waitFor();
      const reload = page.getByRole("button", { name: "Reload draft" });
      if (capture) {
        const dir = createControlUiE2eArtifactDir("claw-draft-save-conflict");
        await page.screenshot({ path: `${dir}/conflict.png`, animations: "disabled" });
      }
      expect(await reload.isEnabled()).toBe(true);
      expect(await editor.inputValue()).toBe(local);
      await gateway.setMethodResponse("claws.drafts.read", latest);
      const canceled = page.waitForEvent("dialog").then(async (dialog) => {
        expect(dialog.message()).toContain("Discard your unsaved changes");
        await dialog.dismiss();
      });
      await reload.click();
      await canceled;
      expect(await editor.inputValue()).toBe(local);
      expect(await gateway.getRequests("claws.drafts.read")).toHaveLength(1);
      const confirmed = page.waitForEvent("dialog").then((dialog) => dialog.accept());
      await reload.click();
      await confirmed;
      await page.waitForFunction(
        (content) => document.querySelector("textarea")?.value === content,
        latest.content,
      );
      expect(await gateway.getRequests("claws.drafts.read")).toHaveLength(2);
      expect(await page.getByRole("button", { name: "Review package" }).isEnabled()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(0);
      if (capture) {
        const dir = createControlUiE2eArtifactDir("claw-draft-recovered");
        await page.screenshot({ path: `${dir}/recovered.png`, animations: "disabled" });
      }
    } finally {
      await context.close();
    }
  });
});
