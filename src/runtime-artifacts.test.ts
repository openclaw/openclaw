import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildId,
  extract,
  useNodeBootstrapArtifactFixtures,
  write,
} from "./gateway/worker-environments/node-bootstrap-artifact.test-support.js";
import { resetPluginLoaderTestStateForTest } from "./plugins/loader.test-fixtures.js";
import {
  prepareWorkerRuntimeArtifacts,
  qualifyWorkerRuntimePlugins,
  resolveNodeBootstrapPlugins,
  workerBundleArchiveRelativePath,
} from "./runtime-artifacts.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "./shared/worker-bundle-hash.js";
import { VERSION } from "./version.js";

const { fixture, tempDirs } = useNodeBootstrapArtifactFixtures();
afterEach(resetPluginLoaderTestStateForTest);

describe("offline installed runtime artifacts", () => {
  it("qualifies the installed bundled command owners without loading configured external code", async () => {
    const root = tempDirs.make("runtime-qualification-");
    await write(root, "extensions/fixture/package.json", {
      name: "@example/fixture",
      version: "1.2.3",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    });
    await write(root, "extensions/fixture/openclaw.plugin.json", {
      id: "fixture",
      configSchema: { type: "object", properties: {} },
    });
    await write(
      root,
      "extensions/fixture/index.mjs",
      `export default {
      id: "fixture",
      nodeHostCommands: [{command: "agent.fixture.run", handle: async () => ({})}],
      register(api) {
        const config = api.runtime.config.current();
        if (config.plugins.entries.fixture.enabled !== true) throw new Error("Registration config mismatch");
        const clone = api.runtime.config.current({clone: true});
        clone.plugins.entries.fixture.enabled = false;
        if (api.runtime.config.current().plugins.entries.fixture.enabled !== true) throw new Error("Registration snapshot changed");
        api.registerAgentHarness({id: "fixture", label: "Fixture",
          cloudPlacement: {mode: "remote-exec", devicePlacement: {
            requiredNodeCommands: ["agent.fixture.run"], consumesWorkerSlot: false}},
          supports: () => ({supported: true}), runAttempt: async () => {throw new Error("not invoked");}});
      }
    };`,
    );
    const builtRoot = path.join(root, "dist/extensions/fixture");
    await fs.mkdir(path.dirname(builtRoot), { recursive: true });
    await fs.cp(path.join(root, "extensions/fixture"), builtRoot, { recursive: true });
    await write(
      root,
      "extensions/fixture/index.mjs",
      'throw new Error("Source runtime must not be loaded");',
    );
    const foreign = tempDirs.make("unselected-runtime-");
    await write(foreign, "package.json", {
      name: "@example/foreign",
      version: "1.2.3",
      openclaw: { extensions: ["./index.js"] },
    });
    await write(foreign, "index.js", 'throw new Error("External runtime must not be loaded");');
    const selection = await qualifyWorkerRuntimePlugins({
      packageRoot: root,
      config: {
        plugins: {
          allow: ["fixture"],
          entries: { fixture: { enabled: true } },
          load: { paths: [foreign] },
        },
      },
    });
    expect(resolveNodeBootstrapPlugins(selection)).toEqual([{ id: "fixture", root: builtRoot }]);
    expect(selection.registry.plugins.map(({ id }) => id)).toEqual(["fixture"]);
  });

  async function runtimeFixture() {
    const installed = await fixture("package");
    for (const name of WORKER_BUNDLE_ARTIFACT_PATHS) {
      await write(installed.packageRoot, `dist/worker/${name}`, "export const ready = true;\n");
    }
    await write(installed.packageRoot, "package.json", {
      ...installed.sourcePackage,
      version: VERSION,
    });
    await write(installed.packageRoot, "dist/build-info.json", { version: VERSION, buildId });
    return { ...installed, outputDirectory: path.join(installed.root, "exported") };
  }

  it("exports both canonical archives with exact build, plugin, size and digest receipts", async () => {
    const installed = await runtimeFixture();
    await fs.rm(path.join(installed.packageRoot, "node_modules/native-runtime"), {
      recursive: true,
    });
    const artifacts = await prepareWorkerRuntimeArtifacts({
      ...installed.options,
      outputDirectory: installed.outputDirectory,
    });
    expect(artifacts.schema).toBe("openclaw.worker-runtime-artifacts.v1");
    expect(artifacts.platform).toBe(process.platform);
    expect(artifacts.arch).toBe(process.arch);
    expect(artifacts.nodeBootstrap.buildId).toBe(buildId);
    expect(artifacts.nodeBootstrap.install).toBe("bundle");
    const unpacked = await extract(installed.root, artifacts.nodeBootstrap);
    const inventory = await fs.readFile(path.join(unpacked, "node-runtime.manifest.json"));
    expect(artifacts.nodeBootstrap.manifestSha256).toBe(
      createHash("sha256").update(inventory).digest("hex"),
    );
    const executed = await promisify(execFile)(process.execPath, [
      path.join(unpacked, "openclaw.mjs"),
    ]);
    expect(executed.stdout.trim()).toBe("local-ai:cloud-ready");
    expect(artifacts.nodeBootstrap.enabledPluginIds).toEqual(["remote-runtime"]);
    for (const archive of [artifacts.nodeBootstrap, artifacts.workerBundle]) {
      const bytes = await fs.readFile(archive.tarballPath);
      expect(archive.tarballBytes).toBe(bytes.length);
      expect(archive.tarballSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(archive.openclawVersion).toBe(VERSION);
      expect(path.relative(installed.outputDirectory, archive.tarballPath)).not.toMatch(/^\.\./u);
    }
    expect(workerBundleArchiveRelativePath(artifacts.workerBundle.tarballSha256)).toBe(
      `worker-artifacts/${artifacts.workerBundle.tarballSha256}.tgz`,
    );
    await expect(
      fs.stat(path.join(installed.packageRoot, "worker-artifacts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports retained packaged worker bytes when the installation has no worker source tree", async () => {
    const installed = await runtimeFixture();
    await fs.rm(path.join(installed.packageRoot, "extensions"), { recursive: true });
    const source = await prepareWorkerRuntimeArtifacts({
      ...installed.options,
      outputDirectory: installed.outputDirectory,
    });
    const retained = path.join(
      installed.packageRoot,
      "dist/worker-artifacts",
      `${source.workerBundle.bundleHash}.tar.gz`,
    );
    await fs.rm(path.dirname(retained), { recursive: true });
    await fs.mkdir(path.dirname(retained), { recursive: true });
    await fs.copyFile(source.workerBundle.tarballPath, retained);
    await fs.rm(path.join(installed.packageRoot, "dist/worker"), { recursive: true });
    const outputDirectory = path.join(installed.root, "packaged-export");
    const exported = await prepareWorkerRuntimeArtifacts({ ...installed.options, outputDirectory });
    expect(exported.workerBundle.tarballPath).toBe(
      path.join(outputDirectory, "worker-bundle", `${source.workerBundle.bundleHash}.tgz`),
    );
    expect(await fs.readFile(exported.workerBundle.tarballPath)).toEqual(
      await fs.readFile(retained),
    );
    expect(exported.workerBundle.tarballSha256).toBe(source.workerBundle.tarballSha256);
  });

  it("joins producers and removes only its staging output when the exact build is rejected", async () => {
    const installed = await runtimeFixture();
    await expect(
      prepareWorkerRuntimeArtifacts({
        ...installed.options,
        runningBuildId: "different-build",
        outputDirectory: installed.outputDirectory,
      }),
    ).rejects.toThrow("running Gateway build");
    await expect(fs.stat(installed.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await fs.readFile(path.join(installed.packageRoot, "package.json"), "utf8")).name,
    ).toBe("openclaw");
  });

  it("refuses output inside the immutable package or over an existing directory", async () => {
    const installed = await runtimeFixture();
    await expect(
      prepareWorkerRuntimeArtifacts({
        ...installed.options,
        outputDirectory: path.join(installed.packageRoot, "output"),
      }),
    ).rejects.toThrow("outside the installed package");
    await fs.mkdir(installed.outputDirectory);
    await write(installed.outputDirectory, "retained.txt", "retain");
    await expect(
      prepareWorkerRuntimeArtifacts({
        ...installed.options,
        outputDirectory: installed.outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(path.join(installed.outputDirectory, "retained.txt"), "utf8")).toBe(
      "retain",
    );
  });
});
