// Opt-in real browser + built Gateway + installed candidate + authenticated API proof.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { pathForRoute } from "../app-route-paths.ts";

const live = process.env.OPENCLAW_DEEPSEEK_UI_LIVE === "1" && Boolean(process.env.DEEPSEEK_API_KEY);
if (!live) {
  it.skip("DeepSeek real-Gateway browser proof requires OPENCLAW_DEEPSEEK_UI_LIVE=1 and DEEPSEEK_API_KEY", () => {});
} else {
  // No Gateway/browser fixture graph is needed when this live proof is skipped.
  const [
    { createOpenClawTestInstance },
    { runQaGatewayFixture },
    { waitForControlUiGatewayReady },
    { takeControlUiScreenshotFrame },
    { createControlUiE2eSuite },
  ] = await Promise.all([
    import("../../../test/helpers/openclaw-test-instance.ts"),
    import("../../../test/helpers/qa-gateway-cleanup.ts"),
    import("../test-helpers/control-ui-e2e-readiness.ts"),
    import("../test-helpers/control-ui-e2e-screenshot.ts"),
    import("./control-ui-e2e-suite.test-support.ts"),
  ]);
  let owner: OpenClawTestInstance;
  const profile = "deepseek-ui-proof";
  const suite = createControlUiE2eSuite({
    name: "DeepSeek search settings with a real Gateway",
    startServerBeforeBrowser: true,
    async startServer() {
      const candidate = process.env.OPENCLAW_DEEPSEEK_UI_PACKAGE?.trim();
      if (!candidate) {
        throw new Error("Pack the candidate and set OPENCLAW_DEEPSEEK_UI_PACKAGE to its tarball.");
      }
      owner = await createOpenClawTestInstance({
        name: profile,
        entrypoint: ["dist/index.js", "--profile", profile],
        env: { OPENCLAW_PROFILE: profile, OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
        config: {
          gateway: { controlUi: { enabled: true } },
          agents: {
            defaults: { model: "deepseek/deepseek-v4-flash", heartbeat: { every: "0m" } },
            entries: { main: {} },
          },
          models: { catalogRefresh: { enabled: false } },
          tools: { web: { search: { enabled: false, maxResults: 3, cacheTtlMinutes: 0 } } },
          plugins: { allow: ["deepseek"] },
          cron: { enabled: false },
        },
      });
      try {
        const install = await owner.cli([
          "plugins",
          "install",
          `npm-pack:${path.resolve(candidate)}`,
          "--force",
          "--accept-capabilities",
        ]);
        expect(install.code, install.stderr).toBe(0);
        await owner.startGateway();
        return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
      } catch (error) {
        return runQaGatewayFixture(
          async (): Promise<never> => {
            throw error;
          },
          () => owner.cleanup(),
        );
      }
    },
  });
  suite.define(() => {
    it("saves DeepSeek search settings, performs a real search, and survives reload", async () => {
      const handoff = await owner.cli(["dashboard", "--json"]);
      expect(handoff.code, handoff.stderr).toBe(0);
      const { browserUrl } = JSON.parse(handoff.stdout) as { browserUrl: string };
      const url = new URL(pathForRoute("search", ""), browserUrl);
      url.hash = new URL(browserUrl).hash;
      await suite.withPage(
        { viewport: { width: 1440, height: 1200 }, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const capture = async (name: string, targets: Locator[]) => {
            const { png } = await takeControlUiScreenshotFrame(page, surface, targets, {
              animations: "disabled",
            });
            await fs.writeFile(path.join(suite.artifactDir, name + ".png"), png);
          };
          const methods: string[] = [];
          page.on("websocket", (socket) =>
            socket.on("framesent", ({ payload }) => {
              const frame = JSON.parse(payload.toString());
              if (frame.type === "req" && frame.method !== "connect") {
                methods.push(frame.method);
              }
            }),
          );
          expect((await page.goto(url.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          const surface = page.locator("openclaw-search-page");
          await surface.getByText("Search provider", { exact: true }).waitFor();
          const picker = surface.getByRole("combobox", { name: "Search provider", exact: true });
          expect(await picker.locator('option[value="deepseek"]').count()).toBe(1);
          await picker.selectOption("deepseek");
          await expect.poll(() => picker.inputValue()).toBe("deepseek");
          await capture("before-setup", [picker, surface.getByText("Off", { exact: true })]);
          const toggle = surface.getByRole("switch", { name: "Web search", exact: true });
          await toggle.check();
          await expect.poll(() => picker.inputValue()).toBe("deepseek");
          const readback = async () => {
            const result = await owner.cli(["config", "get", "tools.web.search", "--json"]);
            expect(result.code, result.stderr).toBe(0);
            return JSON.parse(result.stdout);
          };
          await expect.poll(readback).toMatchObject({ provider: "deepseek", enabled: true });
          await surface
            .getByRole("textbox", { name: "Search query", exact: true })
            .fill("OpenClaw configuration site:docs.openclaw.ai");
          const test = surface.getByRole("button", { name: /^Test (search|DeepSeek)$/ });
          await expect.poll(() => test.isEnabled()).toBe(true);
          await test.click();
          await surface.getByText("Search succeeded", { exact: true }).waitFor({ timeout: 40_000 });
          const source = surface.locator('a[href^="https://docs.openclaw.ai/"]').first();
          await source.waitFor();
          expect(methods).toEqual(expect.arrayContaining(["webSearch.status", "webSearch.test"]));
          expect(methods.some((method) => method.startsWith("config."))).toBe(true);
          await capture("after-live-search", [
            surface.getByText("Search succeeded", { exact: true }),
            source,
          ]);
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => picker.inputValue()).toBe("deepseek");
          expect(await readback()).toMatchObject({ provider: "deepseek", enabled: true });
          const scripts = await page
            .locator('script[type="module"][src]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")!));
          const assets: Array<{ asset: string; sha256: string }> = [];
          for (const src of scripts) {
            const asset = new URL(src, suite.server.baseUrl);
            const response = await page.request.get(asset.toString());
            expect(response.status()).toBe(200);
            const built = await fs.readFile(
              path.join(process.cwd(), "dist/control-ui", asset.pathname.slice(1)),
            );
            const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
            expect(hash(await response.body())).toBe(hash(built));
            assets.push({ asset: asset.pathname, sha256: hash(built) });
          }
          const report = {
            scenario:
              "real installed candidate, real Gateway and Chromium, real authenticated DeepSeek HTTP",
            profile,
            viewport: { width: 1440, height: 1200 },
            assets,
            methods: [...new Set(methods)],
            persistedSearch: await readback(),
            credentialsPrinted: false,
          };
          await fs.writeFile(
            path.join(suite.artifactDir, "report.json"),
            JSON.stringify(report, null, 2),
          );
          console.log(`DeepSeek browser proof: ${suite.artifactDir}`);
        },
      );
    }, 120_000);
  });
}
