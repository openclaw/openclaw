import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  pluginControlUiRevision,
  readPluginControlUiAssets,
} from "../../../../src/plugins/control-ui-assets.ts";
import { loadPluginManifest } from "../../../../src/plugins/manifest.ts";
import { normalizeControlUiBuildInfo } from "../../build-info-normalizers.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  startBuiltControlUiE2eServer,
  waitForConfirmModal,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const suite = createControlUiE2eSuite({
  name: "Packaged Workboard delivery",
  browserLaunchOptions: {
    args: ["--host-resolver-rules=MAP ui.example 127.0.0.1", "--no-proxy-server"],
  },
  async startServer() {
    // Exercise an actual non-loopback HTTP origin, not a mocked secure-context value.
    vi.stubEnv("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", "ui.example");
    try {
      return await startBuiltControlUiE2eServer(path.join(repoRoot, "dist/control-ui"));
    } finally {
      vi.unstubAllEnvs();
    }
  },
});

suite.define(() => {
  it("loads entry, CSS and lazy Workboard chunks from the UI origin with an authenticated remote Gateway", async () => {
    const buildInfo = normalizeControlUiBuildInfo(
      JSON.parse(await fs.readFile(path.join(repoRoot, "dist/build-info.json"), "utf8")),
    );
    const pluginRoot = path.join(repoRoot, "dist/extensions/workboard");
    const manifest = loadPluginManifest(pluginRoot, false);
    if (!manifest.ok || !manifest.manifest.controlUi) {
      throw new Error("Packaged Workboard proof requires a completed pnpm build:ci-artifacts");
    }
    const { controlUi, uiCapabilities } = manifest.manifest;
    const build = await readPluginControlUiAssets(pluginRoot, controlUi, {
      rejectHardlinks: false,
    });
    const revision = pluginControlUiRevision(controlUi, uiCapabilities, build.assets);
    const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"));
    const gatewayUrl = "ws://gateway.example/ws";
    const gatewayPrefix = `http://gateway.example/__openclaw__/plugins/control-ui/workboard/${revision}/`;
    const board = { id: "ops", name: "Operations", total: 0, active: 0, archived: 0, byStatus: {} };
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const errors: string[] = [];
      const requests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => requests.push(request.url()));
      const gateway = await installMockGateway(page, {
        serverBuildId: buildInfo.buildId,
        serverVersion: buildInfo.version ?? undefined,
        controlUiTabs: workboardUi.controlUiTabs,
        pluginAssetsRequireAuth: true,
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "plugins.controlUi.list",
          "plugins.controlUi.report",
        ],
        methodResponses: {
          "plugins.controlUi.list": {
            revision,
            diagnostics: [],
            plugins: [
              {
                pluginId: "workboard",
                name: "Workboard",
                revision,
                uiCapabilities,
                bundledDistribution: { packageName: pkg.name, packageVersion: pkg.version },
                entryUrl: `${gatewayPrefix}${build.entryName}`,
                styles: build.styles.map((name) => `${gatewayPrefix}${name}`),
              },
            ],
          },
          "plugins.controlUi.report": { ok: true },
          "workboard.boards.list": { boards: [board] },
          "workboard.cards.list": { boards: [board], cards: [], statuses: ["todo", "done"] },
        },
      });
      const url = new URL("workboard/ops", suite.server.baseUrl);
      url.hostname = "ui.example";
      url.hash = new URLSearchParams({ gatewayUrl }).toString();
      const response = await page.goto(url.href);
      expect(response?.status()).toBe(200);
      expect(errors).toEqual([]);
      const confirmation = await waitForConfirmModal(page, ".gateway-switch");
      await confirmation
        .getByRole("button", { name: "Switch to gateway.example", exact: true })
        .click();
      await page.locator(".workboard-page-title").filter({ hasText: "Operations" }).waitFor();
      expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
      expect((await gateway.getSocketUrls()).at(-1)).toBe(gatewayUrl);
      expect((await gateway.waitForRequest("plugins.controlUi.report")).params).toMatchObject({
        reports: [{ pluginId: "workboard", revision, status: "activated" }],
      });
      // Deep links retain the shipped relative base; the Gateway resolves any /assets/ segment.
      const prefix = `/assets/plugins/workboard/${revision}/`;
      const assets = requests
        .map((request) => new URL(request))
        .filter((asset) => asset.pathname.includes(prefix));
      expect(assets.every((asset) => asset.origin === url.origin)).toBe(true);
      for (const filename of [build.entryName, ...build.styles]) {
        expect(assets.some((asset) => asset.pathname.endsWith(`${prefix}${filename}`))).toBe(true);
      }
      expect(
        assets.some(
          (asset) =>
            asset.pathname.endsWith(".js") && !asset.pathname.endsWith(`/${build.entryName}`),
        ),
      ).toBe(true);
      expect(requests.some((request) => request.startsWith(gatewayPrefix))).toBe(false);
      expect(errors).toEqual([]);
    });
  });
});
