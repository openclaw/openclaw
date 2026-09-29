import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as buildAll from "../../scripts/build-all.mts";
import { acquireDistArtifactOwnership } from "../../scripts/lib/dist-artifact-lock.mts";
import * as artifactOwnership from "../../scripts/lib/dist-artifact-ownership.mts";
import { prepareVitestRuntime } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { prepareTestRuntime } from "../../scripts/prepare-vitest-runtime.mts";
import * as sourceRunner from "../../scripts/run-node.mts";
import * as postbuild from "../../scripts/runtime-postbuild.mts";
import * as serviceInventory from "../../src/daemon/inspect.js";
import * as gatewayBindings from "../../src/daemon/managed-gateway-bindings.js";
import * as serviceOperation from "../../src/daemon/service-operation-lock.js";
import * as gatewayService from "../../src/daemon/service.js";
import * as systemdFiles from "../../src/daemon/systemd-service-files.js";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const commands = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: commands.prepare,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = tempDirs.make("test-runtime-preparation-");
  env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_RUNNER_LOG: "0" };
  // Keep artifact ownership inside the fixture even when TMPDIR is in another checkout.
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "entry.js"), "original\n");
  vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([]);
  vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
    installed: false,
    loadState: { status: "not-loaded" },
    running: false,
    env: {},
    command: null,
    runtime: { status: "stopped", missingUnit: true },
  });
  vi.spyOn(gatewayBindings, "readManagedGatewayBindingState").mockImplementation((binding) =>
    gatewayService.readGatewayServiceState(gatewayService.resolveGatewayService(), {
      env: binding.env,
    }),
  );
  vi.spyOn(systemdFiles, "readSystemdServiceCommandLocation").mockRejectedValue(
    new Error("native service metadata unavailable"),
  );
  // Old automatic CLI preparation must reach the modeled EACCES, not a host service lock.
  vi.spyOn(serviceOperation, "withGatewayServiceOperationLock").mockImplementation(
    async (_env, callback) => callback(() => {}),
  );
  commands.prepare.mockReset().mockImplementation(async ({ args, env: commandEnv }) => {
    if (args[0] === "scripts/run-node.mjs") {
      return sourceRunner.runNodeMain({ cwd: root, args: args.slice(1), env: commandEnv });
    }
    if (args[0] !== "scripts/prepare-vitest-runtime.mjs") {
      throw new Error(`Unexpected prerequisite command: ${args.join(" ")}`);
    }
    return prepareTestRuntime(root, commandEnv);
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([
  "unavailable service",
  "incomplete inventory",
  "live overlapping service",
  ...(process.platform === "linux"
    ? [
        "disjoint service",
        "shared dist",
        "shared dist-runtime",
        "shared package dist",
        "not-loaded service",
        "unreadable dist",
      ]
    : []),
])("prepares private-QA artifacts only with verified separation: %s", async (service) => {
  vi.mocked(gatewayService.readGatewayServiceState).mockRejectedValue(
    Object.assign(new Error("EACCES: permission denied, open protected-service.env"), {
      code: "EACCES",
    }),
  );
  const admitted = service === "disjoint service" || service === "not-loaded service";
  if (service === "incomplete inventory") {
    vi.mocked(gatewayBindings.discoverManagedGatewayBindings).mockRestore();
    vi.spyOn(serviceInventory, "listManagedOpenClawGatewayServices").mockResolvedValue({
      services: [],
      errors: [{ source: "fixture", message: "Unreadable service directory" }],
    });
  }
  if (
    [
      "disjoint service",
      "shared dist",
      "shared dist-runtime",
      "shared package dist",
      "unreadable dist",
    ].includes(service)
  ) {
    const other = tempDirs.make("serving-runtime-");
    await fs.writeFile(path.join(other, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.mkdir(path.join(other, "dist"));
    await fs.writeFile(path.join(other, "dist", "entry.js"), "original\n");
    if (service === "shared dist") {
      await fs.rm(path.join(root, "dist"), { recursive: true });
      await fs.symlink(path.join(other, "dist"), path.join(root, "dist"));
    }
    if (service === "shared dist-runtime" || service === "shared package dist") {
      const output = service === "shared dist-runtime" ? "dist-runtime" : "packages/sdk/dist";
      await fs.mkdir(path.join(other, output), { recursive: true });
      await fs.mkdir(path.dirname(path.join(root, output)), { recursive: true });
      await fs.symlink(path.join(other, output), path.join(root, output));
    }
    vi.mocked(systemdFiles.readSystemdServiceCommandLocation).mockResolvedValue({
      kind: "command",
      command: {
        programArguments: [process.execPath, path.join(other, "dist", "entry.js"), "gateway"],
      },
    });
    if (service === "unreadable dist") {
      const realpath = fs.realpath;
      vi.spyOn(fs, "realpath").mockImplementation(async (file, ...args) => {
        if (file === path.join(root, "dist")) {
          throw Object.assign(new Error("unreadable artifact path"), { code: "EACCES" });
        }
        return realpath(file, ...args);
      });
    }
  } else if (service === "not-loaded service") {
    vi.mocked(systemdFiles.readSystemdServiceCommandLocation).mockResolvedValue({
      kind: "not-loaded",
    });
  } else if (service === "live overlapping service") {
    vi.mocked(gatewayService.readGatewayServiceState).mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command: {
        programArguments: [process.execPath, path.join(root, "dist", "entry.js"), "gateway"],
      },
      runtime: { status: "running" },
    });
  }
  const runBuild = buildAll.runBuildAllSteps;
  const compiler = vi.fn(async () => {
    await fs.writeFile(path.join(root, "dist", "entry.js"), "rebuilt\n");
    return { status: 0 };
  });
  const build = vi.spyOn(buildAll, "runBuildAllSteps").mockImplementation((profile, params) =>
    runBuild(profile, {
      ...params,
      logger: { error() {}, warn() {} },
      steps: [{ label: "fixture-compiler", args: [] }],
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
      runStep: compiler,
    }),
  );
  const status = await prepareVitestRuntime(
    [{ includePatterns: ["extensions/qa-lab/src/suite-process-lifecycle.test.ts"] }],
    env,
  );
  expect(status).toBe(admitted ? 0 : 1);
  expect(build).toHaveBeenCalledWith(
    "qaRuntime",
    expect.objectContaining({
      cwd: root,
      env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "1" }),
    }),
  );
  expect(compiler).toHaveBeenCalledTimes(admitted ? 1 : 0);
  expect(await fs.readFile(path.join(root, "dist", "entry.js"), "utf8")).toBe(
    admitted ? "rebuilt\n" : "original\n",
  );
  if (admitted) {
    expect(gatewayService.readGatewayServiceState).not.toHaveBeenCalled();
  }
});

it("reuses current artifacts without writable checkout or service access", async () => {
  vi.spyOn(artifactOwnership, "withDistArtifactOwnership").mockRejectedValue(
    Object.assign(new Error("read-only checkout"), { code: "EROFS" }),
  );
  vi.spyOn(sourceRunner, "resolveRunNodePreparation").mockReturnValue({
    build: false,
    runtime: false,
    immutable: false,
  });
  const build = vi.spyOn(buildAll, "runBuildAllSteps");
  expect(await prepareTestRuntime(root, env)).toBe(0);
  expect(build).not.toHaveBeenCalled();
  expect(gatewayService.readGatewayServiceState).not.toHaveBeenCalled();
});

it("refuses to rebuild an immutable deployment", async () => {
  await fs.writeFile(
    path.join(root, "deployment.json"),
    JSON.stringify({ kind: "git", sourceHead: "a".repeat(40) }),
  );
  const build = vi.spyOn(buildAll, "runBuildAllSteps");
  await expect(prepareTestRuntime(root, env)).rejects.toThrow("immutable deployment");
  expect(build).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, "dist", "entry.js"), "utf8")).toBe("original\n");
});

it.each([false, true])(
  "does not compile when only postbuild is stale (fails=%s)",
  async (fails) => {
    vi.spyOn(sourceRunner, "resolveRunNodePreparation").mockReturnValue({
      build: false,
      runtime: true,
      immutable: false,
    });
    const build = vi.spyOn(buildAll, "runBuildAllSteps");
    const sync = vi.spyOn(postbuild, "runRuntimePostBuild").mockImplementation(() => {
      if (fails) {
        throw new Error("postbuild failed");
      }
    });
    if (fails) {
      await expect(prepareTestRuntime(root, env)).rejects.toThrow("postbuild failed");
      await expect(
        fs.access(path.join(root, "dist", ".runtime-postbuildstamp")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await prepareTestRuntime(root, env)).toBe(0);
    }
    expect(sync).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
  },
);

it("leaves postbuild artifacts untouched when service safety cannot be verified", async () => {
  vi.spyOn(sourceRunner, "resolveRunNodePreparation").mockReturnValue({
    build: false,
    runtime: true,
    immutable: false,
  });
  vi.mocked(gatewayService.readGatewayServiceState).mockRejectedValue(new Error("unavailable"));
  const sync = vi.spyOn(postbuild, "runRuntimePostBuild");
  expect(await prepareTestRuntime(root, env)).toBe(1);
  expect(sync).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, "dist", "entry.js"), "utf8")).toBe("original\n");
  await expect(fs.access(path.join(root, "dist", ".runtime-postbuildstamp"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});

it("joins a canceled compiler before releasing checkout ownership", async () => {
  const controller = new AbortController();
  const started = createDeferred();
  const finish = createDeferred();
  const runBuild = buildAll.runBuildAllSteps;
  const finalize = vi.fn(() => true);
  vi.spyOn(buildAll, "runBuildAllSteps").mockImplementation((profile, params) =>
    runBuild(profile, {
      ...params,
      logger: { error() {}, warn() {} },
      steps: [{ label: "fixture-compiler", args: [] }],
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
      finalizeCache: finalize,
      runStep: async () => {
        started.resolve();
        await finish.promise;
        return { status: 0 };
      },
    }),
  );
  const attempt = prepareTestRuntime(root, env, controller.signal);
  try {
    await Promise.race([started.promise, attempt]);
    controller.abort();
    expect(
      await fs.readFile(path.join(root, ".artifacts", "dist-artifacts.lock", "owner.json"), "utf8"),
    ).toContain(String(process.pid));
  } finally {
    finish.resolve();
    await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
  }
  expect(finalize).not.toHaveBeenCalled();
  const next = await acquireDistArtifactOwnership(root);
  await next.release();
});
