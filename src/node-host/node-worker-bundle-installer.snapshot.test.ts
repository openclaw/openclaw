import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as openclawRoot from "../infra/openclaw-root.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as bundleArchive from "../shared/worker-bundle-archive.js";
import { preparePackagedNodeWorkerBundle } from "./node-worker-bundle-cache.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import {
  buildBundleFixture,
  type BundleFixture,
  type BundleFixtureOptions,
} from "./node-worker-bundle-installer.test-support.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

describe("node worker bundle snapshot reuse", () => {
  let root: string;
  let server: http.Server | undefined;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-snapshot-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = undefined;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const bundleFixture = (options?: BundleFixtureOptions) => buildBundleFixture(root, options);
  const bundlesDirectory = (fixture: BundleFixture) =>
    path.join(root, fixture.input.gatewayNamespace, "bundles");
  const bundleDirectory = (fixture: BundleFixture) =>
    path.join(bundlesDirectory(fixture), fixture.input.build.bundleHash);
  async function expectText(file: string, text: string) {
    await expect(fs.readFile(file, "utf8")).resolves.toBe(text);
  }
  async function prepareLocalArchive(fixture: BundleFixture) {
    const packageRoot = path.join(root, "runtime-package");
    const archivePath = path.join(
      packageRoot,
      "worker-artifacts",
      `${fixture.input.archive.sha256}.tgz`,
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, fixture.archive);
    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockReturnValue(packageRoot);
    return archivePath;
  }
  async function serve(fixture: BundleFixture) {
    const requests = vi.fn();
    server = http.createServer((req, res) => {
      requests(req.url);
      if (req.headers.authorization !== `Bearer ${fixture.input.archive.token}`) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-length": String(fixture.archive.byteLength) });
      res.end(fixture.archive);
    });
    return { gatewayUrl: await listen(server), requests };
  }
  function installation(fixture: BundleFixture, gatewayUrl: string) {
    const installer = new NodeWorkerBundleInstaller({ root });
    const { gatewayNamespace, build } = fixture.input;
    return {
      ensure: (extra: Partial<Parameters<typeof installer.ensure>[0]> = {}) =>
        installer.ensure({ input: fixture.input, gatewayUrl, ...extra }),
      inspect: () => installer.inspect({ gatewayNamespace, bundleHash: build.bundleHash }),
      retain: () => installer.retain({ gatewayNamespace, bundleHashes: [build.bundleHash] }),
    };
  }

  it("prewarms canonical package expansion at the producer but never during verify-only", async () => {
    const marker = path.join(root, "producer-prewarm");
    const fixture = await bundleFixture({
      workerSource: `import fs from "node:fs"; if (process.argv[2] !== "--internal-worker-prewarm") throw new Error("unexpected entry"); fs.appendFileSync(${JSON.stringify(marker)}, "warm\\n");`,
    });
    await prepareLocalArchive(fixture);
    await preparePackagedNodeWorkerBundle(fixture.input);
    await expectText(marker, "warm\n");
    await preparePackagedNodeWorkerBundle(fixture.input, true);
    await expectText(marker, "warm\n");
    await preparePackagedNodeWorkerBundle(fixture.input);
    await expectText(marker, "warm\nwarm\n");
  });

  it("reuses fresh snapshot code without scanning or consumer prewarming", async () => {
    const marker = path.join(root, "snapshot-prewarm");
    const fixture = await bundleFixture({ prewarmMarker: marker, bundlePrewarm: 1 });
    await prepareLocalArchive(fixture);
    await preparePackagedNodeWorkerBundle(fixture.input);
    await fs.rm(marker, { force: true });
    const scans = vi.spyOn(bundleArchive, "readWorkerBundleDirectoryManifest");
    const served = await serve(fixture);
    const { ensure, inspect, retain } = installation(fixture, served.gatewayUrl);
    const input = { ...fixture.input, initialSnapshot: "checkpoint-fresh" };
    await ensure({ input });
    await retain();
    await expect(inspect()).resolves.toMatchObject({ status: "installed" });
    expect(scans).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(served.requests).not.toHaveBeenCalled();
  });

  it("does not restore snapshot trust after code admission during the receipt read", async () => {
    const fixture = await bundleFixture({ bundlePrewarm: 1 });
    const archive = await prepareLocalArchive(fixture);
    await preparePackagedNodeWorkerBundle(fixture.input);
    const receipt = path.join(
      path.dirname(archive),
      "expanded",
      fixture.input.build.bundleHash,
      "bootstrap-receipt.json",
    );
    const served = await serve(fixture);
    const installer = new NodeWorkerBundleInstaller({ root });
    const captured = createDeferredCore();
    const release = createDeferredCore();
    const open = fs.open.bind(fs);
    let held = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (args[0] === receipt && !held) {
        held = true;
        captured.resolve();
        await release.promise;
      }
      return file;
    });
    const scans = vi.spyOn(bundleArchive, "readWorkerBundleDirectoryManifest");
    const installing = installer.ensure({
      input: { ...fixture.input, initialSnapshot: "fresh" },
      gatewayUrl: served.gatewayUrl,
    });
    try {
      await Promise.race([
        captured.promise,
        installing.then(() => {
          throw new Error("installation settled before receipt observation");
        }),
      ]);
      installer.invalidateSnapshotPreparation();
    } finally {
      release.resolve();
    }
    await installing;
    expect(scans).toHaveBeenCalled();
  });

  it.each(["code use", "retention", "restart", "checkpoint", "build"] as const)(
    "returns to full integrity checks after snapshot %s changes",
    async (boundary) => {
      const fixture = await bundleFixture({ bundlePrewarm: 1 });
      const archive = await prepareLocalArchive(fixture);
      await preparePackagedNodeWorkerBundle(fixture.input);
      const prepared = path.join(path.dirname(archive), "expanded", fixture.input.build.bundleHash);
      const served = await serve(fixture);
      const original = new NodeWorkerBundleInstaller({ root });
      const input = { ...fixture.input, initialSnapshot: "checkpoint-fresh" };
      await original.ensure({ input, gatewayUrl: served.gatewayUrl });
      await fs.writeFile(path.join(prepared, "worker.mjs"), "export {};!");
      const scans = vi.spyOn(bundleArchive, "readWorkerBundleDirectoryManifest");
      const installer = boundary === "restart" ? new NodeWorkerBundleInstaller({ root }) : original;
      if (boundary === "code use") {
        installer.invalidateSnapshotPreparation();
      } else if (boundary === "retention") {
        await fs.mkdir(path.join(bundlesDirectory(fixture), "e".repeat(64)));
        await installer.retain({
          gatewayNamespace: input.gatewayNamespace,
          bundleHashes: [input.build.bundleHash],
        });
      }
      if (boundary === "code use" || boundary === "retention" || boundary === "restart") {
        await expect(
          installer.inspect({
            gatewayNamespace: input.gatewayNamespace,
            bundleHash: input.build.bundleHash,
          }),
        ).resolves.toMatchObject({ status: "missing" });
      }
      const next =
        boundary === "restart"
          ? fixture.input
          : boundary === "checkpoint"
            ? { ...input, initialSnapshot: "different-checkpoint" }
            : boundary === "build"
              ? { ...input, build: { ...input.build, openclawVersion: "2026.8.2" } }
              : input;
      await expect(
        installer.ensure({ input: next, gatewayUrl: served.gatewayUrl }),
      ).resolves.toEqual(next.build);
      expect(scans).toHaveBeenCalled();
      await expectText(path.join(bundleDirectory(fixture), "worker.mjs"), "export {};\n");
      expect((await fs.lstat(bundleDirectory(fixture))).isSymbolicLink()).toBe(false);
    },
  );

  it.each(["missing", "wrong build", "linked", "foreign alias"] as const)(
    "repairs instead of trusting a %s snapshot receipt",
    async (kind) => {
      const fixture = await bundleFixture();
      const archive = await prepareLocalArchive(fixture);
      await preparePackagedNodeWorkerBundle(fixture.input);
      const prepared = path.join(path.dirname(archive), "expanded", fixture.input.build.bundleHash);
      const receipt = path.join(prepared, "bootstrap-receipt.json");
      if (kind === "foreign alias") {
        await fs.rename(prepared, `${prepared}-foreign`);
        await fs.symlink(
          `${prepared}-foreign`,
          prepared,
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        await fs.unlink(receipt);
      }
      if (kind === "wrong build") {
        await fs.writeFile(
          receipt,
          JSON.stringify({ ...fixture.input.build, openclawVersion: "2026.8.2" }),
        );
      } else if (kind === "linked") {
        const outside = path.join(root, "receipt");
        await fs.writeFile(outside, JSON.stringify(fixture.input.build));
        await fs.symlink(outside, receipt);
      }
      const served = await serve(fixture);
      const { ensure, inspect } = installation(fixture, served.gatewayUrl);
      await ensure({ input: { ...fixture.input, initialSnapshot: "checkpoint-fresh" } });
      expect((await fs.lstat(bundleDirectory(fixture))).isSymbolicLink()).toBe(false);
      await expect(inspect()).resolves.toMatchObject({ status: "installed" });
    },
  );
});
