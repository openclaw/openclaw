import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  expectPrivateQaLabRuntimeSurfaceLoad,
  expectQaLabRuntimeSurfaceLoad,
  makePrivateQaSourceRoot,
} from "./qa-runtime.test-helpers.js";

const loadPluginManifestRegistryCore = vi.hoisted(() => vi.fn());
const loadBundledPluginManifestRegistry = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

// mock-isolation: Exercise discovery with synthetic bundled manifests, not installed plugins.
vi.mock("../plugins/manifest-registry-build.js", () => ({ loadBundledPluginManifestRegistry }));
// mock-isolation: Control the manifest inventory independently of host plugin state.
vi.mock("../plugins/manifest-registry.js", () => ({ loadPluginManifestRegistryCore }));
// mock-isolation: Resolve only the temporary package roots created by this fixture.
vi.mock("../infra/openclaw-root.js", () => ({ resolveOpenClawPackageRootSync }));

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
}));

type ManifestRegistryCall = { env?: NodeJS.ProcessEnv };
type PublicSurfaceCall = {
  artifactBasename?: string;
  dirName?: string;
  env?: NodeJS.ProcessEnv;
};

function firstPublicSurfaceCall(): PublicSurfaceCall | undefined {
  return loadBundledPluginPublicSurfaceModuleSync.mock.calls[0]?.[0] as
    | PublicSurfaceCall
    | undefined;
}

function plugin(origin = "bundled", rootDir = "/tmp/qa-example") {
  return { id: "qa-example", origin, rootDir, qaRunners: [{ commandName: "example" }] };
}

function registry(plugins = [plugin()]) {
  return { plugins, diagnostics: [] };
}

function registration() {
  return {
    commandName: "example",
    adapterFactory: { id: "example", matches: vi.fn(), create: vi.fn() },
    register: vi.fn(),
  };
}

function expectPrivateEnv(env: NodeJS.ProcessEnv | undefined, sourceRoot: string) {
  expect(env).toMatchObject({
    OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sourceRoot, "extensions"),
  });
}

const tempDirs: string[] = [];

beforeAll(() => {
  vi.resetModules();
});

let module: typeof import("./qa-runner-runtime.js");
beforeEach(async () => {
  loadPluginManifestRegistryCore.mockReset().mockReturnValue(registry([]));
  loadBundledPluginManifestRegistry.mockReset().mockReturnValue(registry([]));
  loadBundledPluginPublicSurfaceModuleSync.mockReset();
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
  module = await import("./qa-runner-runtime.js");
});

afterEach(() => {
  cleanupTempDirs(tempDirs);
  vi.unstubAllEnvs();
});

it("loads the qa-lab runtime public surface through the public runner seam", async () => {
  await expectQaLabRuntimeSurfaceLoad({
    importRuntime: () => import("./qa-runner-runtime.js"),
    loadBundledPluginPublicSurfaceModuleSync,
  });
});

it("uses the source bundled tree for qa-lab runtime loading in private qa mode", async () => {
  await expectPrivateQaLabRuntimeSurfaceLoad({
    tempDirs,
    importRuntime: () => import("./qa-runner-runtime.js"),
    loadBundledPluginPublicSurfaceModuleSync,
    resolveOpenClawPackageRootSync,
  });
});

it("loads bundled plugin test APIs with the private QA source tree override", async () => {
  const sourceRoot = makePrivateQaSourceRoot(tempDirs, "openclaw-qa-test-api-root-");
  resolveOpenClawPackageRootSync.mockReturnValue(sourceRoot);

  const testApi = { marker: "matrix-test-api" };
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(testApi);

  expect(module.loadQaRunnerBundledPluginTestApi("matrix")).toBe(testApi);
  const testApiCall = firstPublicSurfaceCall();
  expect(testApiCall).toMatchObject({ dirName: "matrix", artifactBasename: "test-api.js" });
  expectPrivateEnv(testApiCall?.env, sourceRoot);
});

it("reports the qa runtime as unavailable when the qa-lab surface is missing", async () => {
  loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
    throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
  });

  expect(module.isQaRuntimeAvailable()).toBe(false);
});

it("returns activated runner registrations declared in plugin manifests", async () => {
  const entry = registration();
  const adapterFactory = {
    ...entry.adapterFactory,
    isolatesInstances: true,
    supportsModuleFlows: true as const,
  };
  const declared = {
    ...plugin(),
    qaRunners: [{ commandName: "example", description: "Run the example live QA lane" }],
  };
  loadPluginManifestRegistryCore.mockReturnValue(registry([declared]));
  const registered = { ...entry, adapterFactory };
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
    qaRunnerCliRegistrations: [registered],
  });

  expect(module.listQaRunnerCliContributions()).toEqual([
    {
      pluginId: "qa-example",
      commandName: "example",
      description: "Run the example live QA lane",
      status: "available",
      registration: registered,
    },
  ]);
  expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
    dirName: "qa-example",
    artifactBasename: "qa-runner-api.js",
  });
});

it("rejects invalid module-flow support metadata", async () => {
  loadPluginManifestRegistryCore.mockReturnValue(registry());
  const entry = registration();
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
    qaRunnerCliRegistrations: [
      {
        ...entry,
        adapterFactory: { ...entry.adapterFactory, supportsModuleFlows: false },
      },
    ],
  });

  expect(() => module.listQaRunnerCliContributions()).toThrow(
    'QA runner plugin "qa-example" exported an invalid transport factory for "example"',
  );
});

it("reports declared runners as blocked when the plugin is present but not activated", async () => {
  loadPluginManifestRegistryCore.mockReturnValue(registry([plugin("workspace")]));
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

  expect(module.listQaRunnerCliContributions()).toEqual([
    {
      pluginId: "qa-example",
      commandName: "example",
      status: "blocked",
    },
  ]);
});

it("prefers the source bundled tree for private qa discovery in repo checkouts", async () => {
  const sourceRoot = makePrivateQaSourceRoot(tempDirs, "openclaw-qa-runner-root-");
  resolveOpenClawPackageRootSync.mockReturnValue(sourceRoot);

  const entry = registration();
  loadBundledPluginManifestRegistry.mockReturnValue(
    registry([plugin("bundled", path.join(sourceRoot, "extensions", "qa-example"))]),
  );
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
    qaRunnerCliRegistrations: [entry],
  });

  expect(module.listQaRunnerCliContributions()).toEqual([
    {
      pluginId: "qa-example",
      commandName: "example",
      status: "available",
      registration: entry,
    },
  ]);
  const manifestCall = loadBundledPluginManifestRegistry.mock.calls[0]?.[0] as
    | ManifestRegistryCall
    | undefined;
  expectPrivateEnv(manifestCall?.env, sourceRoot);

  const publicSurfaceCall = firstPublicSurfaceCall();
  expect(publicSurfaceCall).toMatchObject({
    dirName: "qa-example",
    artifactBasename: "qa-runner-api.js",
  });
  expectPrivateEnv(publicSurfaceCall?.env, sourceRoot);
});

it("fails fast when two plugins declare the same qa runner command", async () => {
  loadPluginManifestRegistryCore.mockReturnValue(
    registry(
      ["alpha", "beta"].map((id) => ({
        id,
        origin: "workspace",
        rootDir: `/tmp/${id}`,
        qaRunners: [{ commandName: "matrix" }],
      })),
    ),
  );
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

  expect(() => module.listQaRunnerCliContributions()).toThrow(
    'QA runner command "matrix" declared by both "alpha" and "beta"',
  );
});

it("fails when runtime registrations include an undeclared command", async () => {
  loadPluginManifestRegistryCore.mockReturnValue(registry());
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
    qaRunnerCliRegistrations: [registration(), { commandName: "extra", register: vi.fn() }],
  });

  expect(() => module.listQaRunnerCliContributions()).toThrow(
    'QA runner plugin "qa-example" exported "extra" from its QA runner surface but did not declare it in openclaw.plugin.json',
  );
});
