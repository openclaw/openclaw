import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as buildAll from "../../scripts/build-all.mts";
import { acquireDistArtifactOwnership } from "../../scripts/lib/dist-artifact-lock.mts";
import * as artifactOwnership from "../../scripts/lib/dist-artifact-ownership.mts";
import {
  prepareVitestRuntime,
  runE2eGlobalSetup,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
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
const entryPath = (directory = root) => path.join(directory, "dist/entry.js");
const readEntry = () => fs.readFile(entryPath(), "utf8");
async function writeRuntime(directory: string) {
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.mkdir(path.join(directory, "dist"));
  await fs.writeFile(entryPath(directory), "original\n");
}
function mockCompiler(overrides: Parameters<typeof buildAll.runBuildAllSteps>[1]) {
  const runBuild = buildAll.runBuildAllSteps;
  return vi.spyOn(buildAll, "runBuildAllSteps").mockImplementation((profile, params) =>
    runBuild(profile, {
      ...params,
      logger: { error() {}, warn() {} },
      steps: [{ label: "fixture-compiler", args: [] }],
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
      ...overrides,
    }),
  );
}
function mockPreparation(runtime: boolean, build = false) {
  return vi.spyOn(sourceRunner, "resolveRunNodePreparation").mockReturnValue({
    build,
    runtime,
    immutable: false,
  });
}
function serviceState(
  running = false,
): Awaited<ReturnType<typeof gatewayService.readGatewayServiceState>> {
  return {
    installed: running,
    loadState: { status: running ? "loaded" : "not-loaded" },
    running,
    env: {},
    command: running ? { programArguments: [process.execPath, entryPath(), "gateway"] } : null,
    runtime: { status: running ? "running" : "stopped", missingUnit: !running },
  };
}

const prepareAi = () => prepareTestRuntime(root, env, undefined, { withAiPackage: true });

beforeEach(async () => {
  root = tempDirs.make("test-runtime-preparation-");
  env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_RUNNER_LOG: "0" };
  await writeRuntime(root);
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockImplementation(
    async (bindingEnv, options) => (options?.includeInvoking ? [{ env: bindingEnv }] : []),
  );
  vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue(serviceState());
  vi.spyOn(gatewayBindings, "readManagedGatewayBindingState").mockImplementation((binding) =>
    gatewayService.readGatewayServiceState(gatewayService.resolveGatewayService(), {
      env: binding.env,
    }),
  );
  vi.spyOn(systemdFiles, "readSystemdServiceCommandLocation").mockRejectedValue(
    new Error("native service metadata unavailable"),
  );
  vi.spyOn(serviceOperation, "withGatewayServiceOperationLock").mockImplementation(
    async (_env, callback) => callback(() => {}),
  );
  commands.prepare.mockReset().mockImplementation(async ({ args, env: commandEnv }) => {
    if (args[0] !== "scripts/prepare-vitest-runtime.mjs") {
      throw new Error(`Unexpected prerequisite command: ${args.join(" ")}`);
    }
    return prepareTestRuntime(root, commandEnv);
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["0", "1"])(
  "admits E2E readers after one equivalent AI writer: caller DTS=%s",
  async (dts) => {
    env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = dts;
    mockPreparation(true, true);
    const writers: string[] = [];
    mockCompiler({
      steps: undefined,
      runStep: async ({ args, options }) => {
        if (args.includes("scripts/tsdown-build.mts")) {
          expect(options.env?.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe("0");
          writers.push("typed runtime");
          await fs.writeFile(entryPath(), "typed runtime\n");
        }
        return { status: 0 };
      },
    });
    const standalone = async (commandEnv: NodeJS.ProcessEnv, signal?: AbortSignal) => {
      expect(commandEnv).toBe(env);
      const claim = await acquireDistArtifactOwnership(root, false, signal);
      try {
        writers.push("standalone");
        await fs.writeFile(entryPath(), `standalone DTS=${dts}\n`);
      } finally {
        await claim.release();
      }
      return 0;
    };
    commands.prepare.mockImplementation(({ env: commandEnv, signal }) =>
      standalone(commandEnv, signal),
    );
    await runE2eGlobalSetup(async (args, commandEnv) => {
      if (args[0] === "scripts/prepare-vitest-runtime.mjs") {
        return prepareTestRuntime(root, commandEnv, undefined, {
          withAiPackage: args.includes("--with-ai-package"),
        });
      }
      return standalone(commandEnv);
    }, env);
    expect(writers).toEqual(dts === "1" ? ["typed runtime", "standalone"] : ["typed runtime"]);
    expect(await readEntry()).toBe(dts === "1" ? "standalone DTS=1\n" : "typed runtime\n");
  },
);

it.each(["warm", "postbuild", "locked recheck"])(
  "retains the original-environment AI writer after %s preparation",
  async (preparation) => {
    env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = "1";
    const resolvePreparation = mockPreparation(preparation === "postbuild");
    if (preparation === "locked recheck") {
      resolvePreparation.mockReturnValueOnce({ build: true, runtime: true, immutable: false });
    }
    vi.spyOn(postbuild, "runRuntimePostBuild").mockImplementation(() => {});
    const build = vi.spyOn(buildAll, "runBuildAllSteps");
    commands.prepare.mockImplementation(async ({ env: commandEnv, signal }) => {
      expect(commandEnv).toBe(env);
      const claim = await acquireDistArtifactOwnership(root, false, signal);
      await claim.release();
      return 0;
    });
    expect(await prepareAi()).toBe(0);
    expect(commands.prepare).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
  },
);

it("propagates the joined standalone AI writer's failure", async () => {
  mockPreparation(false);
  commands.prepare.mockResolvedValue(23);
  expect(await prepareAi()).toBe(23);
});

it("does not start another writer after a failed compiler generation", async () => {
  mockPreparation(true, true);
  mockCompiler({ steps: undefined, runStep: async () => ({ status: 7 }) });
  expect(await prepareAi()).toBe(7);
  expect(commands.prepare).not.toHaveBeenCalled();
});

it.each([
  { service: "unavailable service" },
  { service: "incomplete inventory" },
  { service: "live overlapping service" },
  ...(process.platform === "linux"
    ? [
        { service: "disjoint service", other: true, admitted: true },
        { service: "shared dist", other: true, shared: "dist" },
        { service: "shared dist-runtime", other: true, shared: "dist-runtime" },
        { service: "shared package dist", other: true, shared: "packages/sdk/dist" },
        { service: "not-loaded service", admitted: true },
        { service: "unreadable dist", other: true },
      ]
    : []),
])("prepares private-QA artifacts only with verified separation: $service", async (scenario) => {
  const { service } = scenario;
  vi.mocked(gatewayService.readGatewayServiceState).mockRejectedValue(
    Object.assign(new Error("EACCES: permission denied, open protected-service.env"), {
      code: "EACCES",
    }),
  );
  const admitted = "admitted" in scenario && scenario.admitted;
  if (service === "incomplete inventory") {
    vi.mocked(gatewayBindings.discoverManagedGatewayBindings).mockRestore();
    vi.spyOn(serviceInventory, "listManagedOpenClawGatewayServices").mockResolvedValue({
      services: [],
      errors: [{ source: "fixture", message: "Unreadable service directory" }],
    });
  }
  if ("other" in scenario) {
    const other = tempDirs.make("serving-runtime-");
    await writeRuntime(other);
    if ("shared" in scenario && scenario.shared) {
      const output = scenario.shared;
      if (output === "dist") {
        await fs.rm(path.join(root, output), { recursive: true });
      }
      await fs.mkdir(path.join(other, output), { recursive: true });
      await fs.mkdir(path.dirname(path.join(root, output)), { recursive: true });
      await fs.symlink(path.join(other, output), path.join(root, output));
    }
    vi.mocked(systemdFiles.readSystemdServiceCommandLocation).mockResolvedValue({
      kind: "command",
      command: { programArguments: [process.execPath, entryPath(other), "gateway"] },
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
    vi.mocked(gatewayService.readGatewayServiceState).mockResolvedValue(serviceState(true));
  }
  const compiler = vi.fn(async ({ options }: { options: { env?: NodeJS.ProcessEnv } }) => {
    expect(options.env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    await fs.writeFile(entryPath(), "rebuilt\n");
    return { status: 0 };
  });
  mockCompiler({ runStep: compiler });
  const status = await prepareVitestRuntime(
    [{ includePatterns: ["extensions/qa-lab/src/suite-process-lifecycle.test.ts"] }],
    env,
  );
  expect(status).toBe(admitted ? 0 : 1);
  expect(compiler).toHaveBeenCalledTimes(admitted ? 1 : 0);
  expect(await readEntry()).toBe(admitted ? "rebuilt\n" : "original\n");
  if (admitted) {
    expect(gatewayService.readGatewayServiceState).not.toHaveBeenCalled();
  }
});

it.each(["current artifacts", "immutable deployment"])("does not rebuild %s", async (state) => {
  const build = vi.spyOn(buildAll, "runBuildAllSteps");
  if (state === "current artifacts") {
    vi.spyOn(artifactOwnership, "withDistArtifactOwnership").mockRejectedValue(
      Object.assign(new Error("read-only checkout"), { code: "EROFS" }),
    );
    mockPreparation(false);
    expect(await prepareTestRuntime(root, env)).toBe(0);
    expect(gatewayService.readGatewayServiceState).not.toHaveBeenCalled();
  } else {
    await fs.writeFile(
      path.join(root, "deployment.json"),
      JSON.stringify({ kind: "git", sourceHead: "a".repeat(40) }),
    );
    await expect(prepareTestRuntime(root, env)).rejects.toThrow("immutable deployment");
  }
  expect(build).not.toHaveBeenCalled();
  expect(await readEntry()).toBe("original\n");
});

it.each(["success", "failure", "unverified service"])(
  "does not compile when only postbuild is stale: %s",
  async (outcome) => {
    mockPreparation(true);
    const build = vi.spyOn(buildAll, "runBuildAllSteps");
    const sync = vi.spyOn(postbuild, "runRuntimePostBuild");
    if (outcome === "unverified service") {
      vi.mocked(gatewayService.readGatewayServiceState).mockRejectedValue(new Error("unavailable"));
    } else {
      sync.mockImplementation(() => {
        if (outcome === "failure") {
          throw new Error("postbuild failed");
        }
      });
    }
    if (outcome === "failure") {
      await expect(prepareTestRuntime(root, env)).rejects.toThrow("postbuild failed");
    } else {
      expect(await prepareTestRuntime(root, env)).toBe(outcome === "unverified service" ? 1 : 0);
    }
    if (outcome !== "success") {
      await expect(
        fs.access(path.join(root, "dist", ".runtime-postbuildstamp")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (outcome === "unverified service") {
      expect(sync).not.toHaveBeenCalled();
      expect(await readEntry()).toBe("original\n");
    } else {
      expect(sync).toHaveBeenCalledOnce();
    }
    expect(build).not.toHaveBeenCalled();
  },
);

it("joins a canceled compiler before releasing checkout ownership", async () => {
  const controller = new AbortController();
  const started = createDeferred();
  const finish = createDeferred();
  const finalize = vi.fn(() => true);
  mockCompiler({
    finalizeCache: finalize,
    runStep: async () => {
      started.resolve();
      await finish.promise;
      return { status: 0 };
    },
  });
  const attempt = prepareTestRuntime(root, env, controller.signal, { withAiPackage: true });
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
  expect(commands.prepare).not.toHaveBeenCalled();
  const next = await acquireDistArtifactOwnership(root);
  await next.release();
});

it("keeps UI preparation current-head even after another runtime group was prepared", async () => {
  commands.prepare.mockResolvedValueOnce(7);
  expect(
    await prepareVitestRuntime([{ configs: ["test/vitest/vitest.ui-e2e.config.ts"] }], env, {
      runtimePrepared: true,
    }),
  ).toBe(7);
  expect(commands.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      args: ["scripts/prepare-vitest-runtime.mjs", "--require-current-head"],
    }),
  );
});
