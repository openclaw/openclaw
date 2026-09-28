import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { LobsterCatalogEntry } from "../../../packages/gateway-protocol/src/lobsterdex.ts";
import { readPluginInstallRecords } from "../../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const execFileAsync = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pluginId = "reef-lobsters";
const coralId = `${pluginId}/reef/coral`;
const sourceRoot = path.resolve("examples/plugins/lobster-pack");
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance;
let readback: GatewayClient | undefined;
let installedRoot = "";
const receipt: Record<string, unknown> = {
  scenario: "local npm-pack installed Lobster Pack",
  publishedRelease: false,
  transport: "real Gateway RPC and authenticated HTTP; no interception",
};
const connectReadback = async () =>
  acquireGatewayTestClient(
    {
      url: instance.url,
      token: instance.gatewayToken,
      env: instance.env,
      clientName: "cli",
      mode: "cli",
      scopes: ["operator.read"],
      deviceIdentity: null,
      deviceAuthScope: instance.url,
      sharedStateMode: "read-only",
      requestTimeoutMs: 30_000,
    },
    {
      timeoutMs: 10_000,
      timeoutMessage: "Lobster catalog client did not connect",
      closeMessage: "Lobster catalog client closed",
    },
  );
const suite = createControlUiE2eSuite({
  name: "Installed Lobster Pack with real Gateway",
  startServerBeforeBrowser: true,
  setupTimeoutMs: 180_000,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "lobster-pack-installed",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true, basePath: "/reef-console" } },
        cron: { enabled: false },
        agents: { ownership: "explicit", list: [{ id: "main" }] },
        plugins: { allow: [] },
      },
    });
    try {
      const packDir = path.join(instance.homeDir, "candidate");
      await fs.mkdir(packDir);
      const packed = await execFileAsync(
        "npm",
        ["pack", sourceRoot, "--ignore-scripts", "--json", "--pack-destination", packDir],
        { env: instance.env, timeout: 30_000 },
      );
      const packages = JSON.parse(packed.stdout) as Array<{
        filename: string;
        files: Array<{ path: string }>;
      }>;
      const packageInfo = packages[0];
      if (!packageInfo) {
        throw new Error("npm pack returned no package");
      }
      const packedFiles = packageInfo.files.map((file) => file.path);
      expect(packedFiles).toEqual(
        expect.arrayContaining([
          "openclaw.plugin.json",
          "reef.json",
          "assets/coral.svg",
          "assets/tide.png",
          "index.js",
        ]),
      );
      expect(packedFiles.some((file) => /(?:package-lock|npm-shrinkwrap)\.json$/u.test(file))).toBe(
        false,
      );
      const tarball = path.join(packDir, packageInfo.filename);
      receipt.package = {
        filename: packageInfo.filename,
        sha256: sha256(await fs.readFile(tarball)),
        files: packedFiles,
      };
      const install = await instance.cli(
        ["plugins", "install", `npm-pack:${tarball}`, "--force", "--accept-capabilities"],
        {
          timeoutMs: 90_000,
        },
      );
      expect(install.code, install.stderr).toBe(0);
      const enabled = await instance.cli(["plugins", "enable", pluginId]);
      expect(enabled.code, enabled.stderr).toBe(0);
      const records = readPluginInstallRecords({
        stateDir: instance.stateDir,
        configPath: instance.configPath,
      });
      const record = records[pluginId];
      if (!record || typeof record.installPath !== "string") {
        throw new Error("Installer did not persist an installed package path");
      }
      installedRoot = record.installPath;
      expect(await fs.realpath(installedRoot)).not.toBe(await fs.realpath(sourceRoot));
      receipt.install = {
        command: "plugins install npm-pack:<candidate.tgz> --force --accept-capabilities",
        exitCode: install.code,
        enableExitCode: enabled.code,
        source: record.source,
        copiedOutsideSource: true,
      };
      await instance.startGateway();
      readback = await connectReadback();
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        close: () =>
          runQaGatewayFixture(
            () => readback?.stopAndWait(),
            () => instance.cleanup(),
          ),
      };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("serves installed asset bytes with auth and withdraws the catalog after actual disable", async () => {
    const proof = capture ? createControlUiE2eArtifactDir("installed-lobster-pack") : undefined;
    if (!readback) {
      throw new Error("Real Gateway client unavailable");
    }
    const initial = await readback.request<{ entries: LobsterCatalogEntry[] }>(
      "lobsterdex.catalog",
      {},
    );
    expect(initial.entries.map((entry) => entry.id).toSorted()).toEqual([
      coralId,
      `${pluginId}/reef/tide`,
    ]);
    receipt.catalog = initial.entries.map(({ id, appearance }) => ({
      id,
      kind: appearance.kind,
      resourcePath: appearance.url,
    }));
    const assets: Array<Record<string, unknown>> = [];
    for (const entry of initial.entries) {
      const file = entry.appearance.kind === "svg" ? "assets/coral.svg" : "assets/tide.png";
      const resourcePath = `/reef-console${entry.appearance.url}`;
      const url = new URL(resourcePath, suite.server.baseUrl);
      const denied = await fetch(url);
      await denied.arrayBuffer();
      expect([401, 403]).toContain(denied.status);
      const authorized = await fetch(url, {
        headers: { Authorization: `Bearer ${instance.gatewayToken}` },
      });
      expect(authorized.status).toBe(200);
      const contentType = authorized.headers.get("content-type");
      expect(contentType).toContain(
        entry.appearance.kind === "svg" ? "image/svg+xml" : "image/png",
      );
      const servedHash = sha256(new Uint8Array(await authorized.arrayBuffer()));
      const installedHash = sha256(await fs.readFile(path.join(installedRoot, file)));
      const sourceHash = sha256(await fs.readFile(path.join(sourceRoot, file)));
      expect(servedHash).toBe(installedHash);
      expect(installedHash).toBe(sourceHash);
      assets.push({
        id: entry.id,
        file,
        resourcePath,
        unauthenticatedStatus: denied.status,
        authenticatedStatus: authorized.status,
        contentType,
        servedSha256: servedHash,
        installedSha256: installedHash,
        sourceSha256: sourceHash,
      });
    }
    receipt.assets = assets;
    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const dashboard = JSON.parse(handoff.stdout) as { browserUrl: string };
    const destination = new URL("/reef-console/settings/lobsterdex", dashboard.browserUrl);
    destination.hash = new URL(dashboard.browserUrl).hash;
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1100, height: 760 }, locale: "en-US" },
      async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        await page.goto(destination.href);
        await waitForControlUiGatewayReady(page);
        const pack = page.locator('[data-lobster-pack="reef-lobsters/reef"]');
        await pack.waitFor();
        await expect
          .poll(() =>
            pack
              .locator("img")
              .evaluateAll(
                (images) =>
                  images.length === 2 &&
                  images.every(
                    (image) => image instanceof HTMLImageElement && image.naturalWidth > 0,
                  ),
              ),
          )
          .toBe(true);
        expect(await pack.locator("img").count()).toBe(2);
        await pack.scrollIntoViewIfNeeded();
        if (proof) {
          await page.screenshot({ path: path.join(proof, "01-installed-pack.png") });
        }
        receipt.browser = {
          handoffExitCode: handoff.code,
          renderedCustomImages: 2,
          capturedInstalled: Boolean(proof),
        };
        await readback?.stopAndWait();
        readback = undefined;
        await instance.stopGateway();
        const disabled = await instance.cli(["plugins", "disable", pluginId]);
        expect(disabled.code, disabled.stderr).toBe(0);
        await instance.startGateway();
        readback = await connectReadback();
        const finalCatalog = await readback.request<{ entries: LobsterCatalogEntry[] }>(
          "lobsterdex.catalog",
          {},
        );
        expect(finalCatalog.entries).toEqual([]);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => pack.count()).toBe(0);
        for (const entry of initial.entries) {
          const withdrawn = await fetch(
            new URL(`/reef-console${entry.appearance.url}`, suite.server.baseUrl),
            {
              headers: { Authorization: `Bearer ${instance.gatewayToken}` },
            },
          );
          await withdrawn.arrayBuffer();
          expect(withdrawn.status).toBe(404);
        }
        if (proof) {
          await page.screenshot({ path: path.join(proof, "02-disabled-pack.png") });
        }
        receipt.disable = {
          command: "plugins disable reef-lobsters",
          exitCode: disabled.code,
          taskOwnedGatewayRestarted: true,
          catalogEntries: finalCatalog.entries.length,
          artworkStatus: 404,
        };
      },
    );
    if (proof) {
      await fs.writeFile(
        path.join(proof, "runtime-proof.json"),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    }
  }, 120_000);
});
