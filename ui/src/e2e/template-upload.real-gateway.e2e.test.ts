import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Template upload with a real built Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    // CI's prebuilt setup binds stamps to clean source and verifies the asset generation.
    // Explicit entrypoint prevents a missing build from falling back to source preparation.
    for (const file of [
      "dist/index.js",
      "dist/.buildstamp",
      "dist/.runtime-postbuildstamp",
      "dist/control-ui/.build-inputs.json",
    ]) {
      expect((await readFile(file)).length, file).toBeGreaterThan(0);
    }
    const owner = await createOpenClawTestInstance({
      name: "template-upload",
      entrypoint: ["dist/index.js"],
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: {
          controlUi: {
            enabled: true,
            root: path.resolve("dist/control-ui"),
            experimental: { templates: true },
          },
          reload: { mode: "hybrid" },
        },
        plugins: { allow: [] },
        cron: { enabled: false },
        logging: { level: "info", consoleLevel: "error" },
      },
    });
    instance = owner;
    try {
      const validation = await owner.cli(["config", "validate", "--json"]);
      expect(validation.code, validation.stdout || validation.stderr).toBe(0);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      return await runQaGatewayFixture(
        async (): Promise<never> => {
          throw error;
        },
        () => owner.cleanup(),
      );
    }
  },
});

suite.define(() => {
  it("uploads an actual archive, reviews, and installs persisted agent files", async () => {
    const owner = instance!;
    const source = path.join(owner.stateDir, "synthetic-upload");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "@proof/upload-proof",
        version: "0.1.0",
        openclaw: { template: "CLAW.md" },
      }),
    );
    await writeFile(
      path.join(source, "CLAW.md"),
      "---\nschemaVersion: 1\nagent:\n  id: upload-proof\n  name: Upload Proof\n---\nSynthetic upload proof.\n",
    );
    await writeFile(path.join(source, "SOUL.md"), "Synthetic upload proof instructions.\n");
    const archive = path.join(owner.stateDir, "upload-proof.tgz");
    await tar.c({ gzip: true, cwd: source, file: archive }, ["package.json", "CLAW.md", "SOUL.md"]);
    let dashboard = await owner.cli(["dashboard", "--json"]);
    await expect
      .poll(
        async () => {
          if (dashboard.code !== 0) {
            dashboard = await owner.cli(["dashboard", "--json"]);
          }
          return dashboard.code;
        },
        { timeout: 45_000, message: owner.logs() },
      )
      .toBe(0);
    const handoff = JSON.parse(dashboard.stdout);
    const url = new URL("templates", handoff.browserUrl);
    url.hash = new URL(handoff.browserUrl).hash;
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      expect((await page.goto(url.toString()))?.status()).toBe(200);
      await waitForControlUiGatewayReady(page);
      const input = page.getByLabel("Template archive", { exact: true });
      await input.waitFor();
      await page.getByText("Appliance care coordinator", { exact: true }).waitFor();
      const entry = await page
        .locator('script[type="module"][src*="/assets/index-"]')
        .getAttribute("src");
      expect(entry).toBeTruthy();
      const asset = new URL(entry!, page.url());
      const served = await page.request.get(asset.toString(), {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(served.status()).toBe(200);
      expect(digest(await served.body())).toBe(
        digest(await readFile(path.join("dist/control-ui", asset.pathname.replace(/^\//u, "")))),
      );

      const capture = async (name: string, content: import("playwright").Locator) => {
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [content], {
          animations: "disabled",
          viewport: { width: 1280, height: 900 },
          scrollTo: content,
        });
        await writeFile(path.join(suite.artifactDir, name), frame.png);
      };
      await capture("before-selection.png", input);
      await input.setInputFiles(archive);
      const confirm = page.getByRole("button", { name: "Add anyway", exact: true });
      await expect.poll(() => confirm.isVisible()).toBe(true);
      await capture("review.png", confirm);
      await confirm.click();
      const success = page.getByText("Installed agent: upload-proof", { exact: true });
      await expect.poll(() => success.isVisible()).toBe(true);
      await capture("installed.png", success);
      const config = JSON.parse(await readFile(owner.configPath, "utf8"));
      const agent = config.agents.entries["upload-proof"];
      expect(agent).toBeTruthy();
      expect((await stat(agent.workspace)).isDirectory()).toBe(true);
    });
  });
});
