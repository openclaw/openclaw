import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import {
  useNodeBootstrapArtifactFixtures,
  write,
} from "./gateway/worker-environments/node-bootstrap-artifact.test-support.js";
import { writePlugin, writePluginMetadata } from "./plugins/loader.test-fixtures.js";
import {
  qualifyWorkerRuntimePlugins,
  resolveNodeBootstrapPlugins,
  prepareWorkerRuntimeArtifacts,
} from "./runtime-artifacts.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "./shared/worker-bundle-hash.js";
import { VERSION } from "./version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nodeFixtures = useNodeBootstrapArtifactFixtures();
afterEach(() => vi.unstubAllEnvs());

it("derives node packages from an actual nonactivated bundled generation and honors disablement", async () => {
  const packageRoot = fs.realpathSync(tempDirs.make("runtime-qualification-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(packageRoot, "unopened-state"));
  const root = path.join(packageRoot, "extensions", "fixture-runtime");
  writePlugin({
    id: "fixture-runtime",
    dir: root,
    filename: "index.cjs",
    registration: `
      api.registerAgentHarness({ id: "fixture-runtime", label: "Fixture runtime", supports: () => ({supported: true}),
        cloudPlacement: { mode: "remote-exec", devicePlacement: { requiredNodeCommands: ["fixture.native"], consumesWorkerSlot: false } },
        runAttempt: async () => { throw new Error("Not executed by artifact qualification"); }
      });
      api.registerNodeHostCommand({ command: "fixture.native", handle: async () => "{}" });`,
  });
  writePluginMetadata({
    dir: root,
    id: "fixture-runtime",
    packageJson: {
      name: "@fixture/runtime",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    },
  });
  const config = {
    plugins: { slots: { memory: "none" }, entries: { "fixture-runtime": { enabled: true } } },
  };
  const selection = await qualifyWorkerRuntimePlugins({ packageRoot, config });
  expect(resolveNodeBootstrapPlugins(selection)).toEqual([{ id: "fixture-runtime", root }]);
  expect(selection.metadata.byPluginId.get("fixture-runtime")).toMatchObject({
    packageName: "@fixture/runtime",
    packageVersion: "1.0.0",
    rootDir: root,
    origin: "bundled",
  });
  expect(fs.existsSync(path.join(packageRoot, "unopened-state"))).toBe(false);
  config.plugins.entries["fixture-runtime"].enabled = false;
  const disabled = await qualifyWorkerRuntimePlugins({ packageRoot, config });
  expect(resolveNodeBootstrapPlugins(disabled)).toEqual([]);
});

it("exports actual matching node and worker archives through both canonical producers", async () => {
  const fixture = await nodeFixtures.fixture("package");
  // This entry exports its own installed generation, not another host version.
  await write(fixture.packageRoot, "package.json", { ...fixture.sourcePackage, version: VERSION });
  await write(fixture.packageRoot, "dist/build-info.json", {
    version: VERSION,
    buildId: fixture.options.runningBuildId,
  });
  for (const file of WORKER_BUNDLE_ARTIFACT_PATHS) {
    await write(fixture.packageRoot, `dist/worker/${file}`, "export const fixture = true;\n");
  }
  const outputDirectory = path.join(fixture.root, "export");
  const exported = await prepareWorkerRuntimeArtifacts({ ...fixture.options, outputDirectory });
  expect(exported.schema).toBe("openclaw.worker-runtime-artifacts.v1");
  expect(exported.nodeBootstrap.openclawVersion).toBe(VERSION);
  expect(exported.workerBundle.openclawVersion).toBe(exported.nodeBootstrap.openclawVersion);
  for (const artifact of [exported.nodeBootstrap, exported.workerBundle]) {
    const bytes = fs.readFileSync(artifact.tarballPath);
    expect(bytes.length).toBe(artifact.tarballBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.tarballSha256);
  }
  await expect(
    prepareWorkerRuntimeArtifacts({ ...fixture.options, outputDirectory }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(fs.readFileSync(exported.workerBundle.tarballPath).length).toBe(
    exported.workerBundle.tarballBytes,
  );
});
