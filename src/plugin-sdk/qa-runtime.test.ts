import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  LiveTransportQaCliRegistrationOptions,
  QaDockerFetchLike,
  QaDockerRunCommand,
} from "./qa-runtime.js";

const loadPluginManifestRegistryCore = vi.hoisted(() => vi.fn());
const loadBundledPluginManifestRegistry = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

// mock-isolation: Exercise discovery with synthetic bundled manifests, not installed plugins.
vi.mock("../plugins/manifest-registry-build.js", () => ({ loadBundledPluginManifestRegistry }));
// mock-isolation: Control the manifest inventory independently of host plugin state.
vi.mock("../plugins/manifest-registry.js", () => ({ loadPluginManifestRegistryCore }));
// mock-isolation: Keep QA discovery/runtime tests on synthetic surfaces, never installed plugins.
vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
}));

// mock-isolation: Resolve only the temporary package roots created by this fixture.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

beforeAll(() => {
  vi.resetModules();
});

let runner: typeof import("./qa-runner-runtime.js");
let module: typeof import("./qa-runtime.js");
beforeEach(async () => {
  loadPluginManifestRegistryCore.mockReset().mockReturnValue(registry([]));
  loadBundledPluginManifestRegistry.mockReset().mockReturnValue(registry([]));
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  loadBundledPluginPublicSurfaceModuleSync.mockReset();
  resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
  runner = await import("./qa-runner-runtime.js");
  module = await import("./qa-runtime.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function occupyLoopbackPort(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createServer();
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server address unavailable");
  }
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const dockerRuntime = () => module.createQaDockerRuntime({ auditContext: "qa-test" });
const healthUrl = "http://127.0.0.1:18789/healthz";
const composeFile = "/tmp/docker-compose.yml";
const repoRoot = "/repo";
const commandOutput = (stdout: string) => ({ stdout, stderr: "" });
const registerCli = (
  run: LiveTransportQaCliRegistrationOptions["run"],
  overrides: Partial<LiveTransportQaCliRegistrationOptions> = {},
) => {
  const qa = new Command();
  module
    .createLiveTransportQaCliRegistration({ ...registrationOptions(run), ...overrides })
    .register(qa);
  return (args: string[] = []) => qa.parseAsync(["node", "openclaw", "telegram", ...args]);
};

function registrationOptions(
  run: LiveTransportQaCliRegistrationOptions["run"],
): LiveTransportQaCliRegistrationOptions {
  return {
    commandName: "telegram",
    defaultProviderMode: "mock-openai",
    description: "Synthetic transport registration",
    providerModeHelp: "Provider mode",
    outputDirHelp: "Artifact directory",
    scenarioHelp: "Run only the named scenario",
    sutAccountHelp: "Temporary SUT account",
    run,
  };
}

const mockAsync = () => vi.fn(async () => {});
const surface = (value: object | null) =>
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(value);
const listContributions = () => runner.listQaRunnerCliContributions();
const expectSurface = (dirName: string, artifactBasename: string, sourceRoot?: string) =>
  expect(loadBundledPluginPublicSurfaceModuleSync.mock.calls[0]?.[0]).toEqual({
    dirName,
    artifactBasename,
    ...(sourceRoot ? { env: privateEnv(sourceRoot) } : {}),
  });

function cancelTrackedFetchResponse(ok = true) {
  const cancel = vi.fn(async () => {});
  return { response: { ok, body: { cancel } }, cancel };
}

it("stays cold until the runtime seam is used", async () => {
  vi.resetModules();
  await import("./qa-runtime.js");

  expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
});

it.each([
  ["Unable to resolve bundled plugin public surface qa-lab/runtime-api.js", true],
  ["Failed to evaluate qa-lab/runtime-api.js: invalid runtime export", false],
] as const)("classifies loader failure: %s", (message, absent) => {
  loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
    throw new Error(message);
  });
  if (absent) {
    expect(module.isQaRuntimeAvailable()).toBe(false);
  } else {
    expect(() => module.isQaRuntimeAvailable()).toThrow(message);
  }
});

it("runs a plugin-owned transport through the private QA suite host", async () => {
  const runLiveTransportQaSuiteCommand = mockAsync();
  surface({ runLiveTransportQaSuiteCommand });
  const request = {
    channelId: "buzz",
    defaultProviderMode: "mock-openai",
    options: { providerMode: "mock-openai" },
    selectScenarioIds: vi.fn(() => ["channel-canary"]),
  };
  await module.runLiveTransportQaSuiteCommand(request);
  expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith(request);
});

it("registers shared live transport QA CLI options", async () => {
  const run = mockAsync();
  const parse = registerCli(run, {
    credentialFileHelp: "Private JSON credential file",
    credentialOptions: {
      sourceDescription: "Credential source for Telegram QA",
      roleDescription: "Credential role for Telegram QA",
    },
    defaultProviderMode: "live-frontier",
    description: "Run Telegram QA",
    listScenariosHelp: "List Telegram scenarios",
    profileHelp: "QA profile",
    failFastHelp: "Stop after first failure",
    allowFailuresHelp: "Allow failures",
  });

  await parse();
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ fastMode: undefined }));
  run.mockClear();

  const mappings = [
    ["repo-root", "/tmp/repo", "repoRoot"],
    ["output-dir", ".artifacts/qa", "outputDir"],
    ["provider-mode", "mock-openai", "providerMode"],
    ["model", "primary", "primaryModel"],
    ["alt-model", "alternate", "alternateModel"],
    ["fast", true, "fastMode"],
    ["allow-failures", true, "allowFailures"],
    ["list-scenarios", true, "listScenarios"],
    ["profile", "fast", "profile"],
    ["fail-fast", true, "failFast"],
    ["sut-account", "sut-2", "sutAccountId"],
    ["credential-file", "/secure/telegram-qa.json", "credentialFile"],
    ["credential-source", "convex", "credentialSource"],
    ["credential-role", "maintainer", "credentialRole"],
  ] as const;
  await parse([
    ...mappings.flatMap(([flag, value]) => (value === true ? [`--${flag}`] : [`--${flag}`, value])),
    "--scenario",
    "alpha",
    "--scenario",
    "  ",
    "--scenario",
    "beta",
  ]);
  expect(run).toHaveBeenCalledWith({
    ...Object.fromEntries(mappings.map(([, value, key]) => [key, value])),
    scenarioIds: ["alpha", "beta"],
  });
});

it("reports a blank dedicated QA scenario selection without dispatching", async () => {
  const dispatchedScenarioIds: string[][] = [];
  const parse = registerCli(async (options) => {
    dispatchedScenarioIds.push(options.scenarioIds ?? []);
  });

  const previousExitCode = process.exitCode;
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await parse(["--scenario", " \t "]);

    expect(stderrWrite).toHaveBeenCalledWith(
      "--scenario must name at least one non-empty scenario id.\n",
    );
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExitCode;
    stderrWrite.mockRestore();
  }
  expect(dispatchedScenarioIds).toEqual([]);
});

it("shares Docker health parsing across array and jsonl compose output", async () => {
  const dockerPsOutputs = ['[{"Health":"starting"}]', '{"State":"running"}\n'];
  const runCommand = vi.fn(async () =>
    commandOutput(dockerPsOutputs.shift() ?? '{"State":"running"}'),
  );
  const sleepImpl = mockAsync();
  await dockerRuntime().waitForDockerServiceHealth(
    "homeserver",
    composeFile,
    repoRoot,
    runCommand,
    sleepImpl,
  );

  expect(runCommand).toHaveBeenCalledTimes(2);
  expect(sleepImpl).toHaveBeenCalledTimes(1);
});

it("cancels compose service health probe response bodies", async () => {
  const runCommand = vi.fn<QaDockerRunCommand>(async (_command, args) =>
    commandOutput(args.includes("ps") ? "qa-gateway-one\n" : "172.18.0.4\n"),
  );
  const probe = cancelTrackedFetchResponse(true);
  const fetchImpl = vi.fn(async () => probe.response);

  await expect(
    dockerRuntime().resolveComposeServiceUrl(
      "gateway",
      18789,
      composeFile,
      repoRoot,
      runCommand,
      fetchImpl,
    ),
  ).resolves.toBe("http://172.18.0.4:18789/");
  expect(probe.cancel).toHaveBeenCalledOnce();
});

it("cancels the guarded default health response before stripping its body", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
  await expect(dockerRuntime().fetchHealthUrl(healthUrl)).resolves.toEqual({ ok: false });
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels waitForHealth response bodies after each probe", async () => {
  const first = cancelTrackedFetchResponse(false);
  const second = cancelTrackedFetchResponse(true);
  const responses = [first.response, second.response];
  const fetchImpl = vi.fn(async () => responses.shift() ?? second.response);
  const sleepImpl = mockAsync();
  await dockerRuntime().waitForHealth(healthUrl, {
    fetchImpl,
    sleepImpl,
    timeoutMs: 1000,
    pollMs: 1,
  });

  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(second.cancel).toHaveBeenCalledOnce();
});

it("bounds a stalled waitForHealth probe by the remaining overall deadline", async () => {
  let probeSignal: AbortSignal | undefined;
  const fetchImpl = vi.fn(async (_input: string, init?: Pick<RequestInit, "signal">) => {
    probeSignal = init?.signal ?? undefined;
    if (!probeSignal) {
      throw new Error("health probe signal missing");
    }
    if (!probeSignal.aborted) {
      await once(probeSignal, "abort");
    }
    throw new Error("health probe aborted");
  });
  const sleepImpl = mockAsync();
  const startedAt = Date.now();
  const now = vi.spyOn(performance, "now").mockReturnValue(100.25).mockReturnValueOnce(100);

  try {
    await expect(
      dockerRuntime().waitForHealth(healthUrl, {
        fetchImpl,
        sleepImpl,
        timeoutMs: 25,
        pollMs: 1_000,
      }),
    ).rejects.toThrow("did not become healthy");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(probeSignal?.aborted).toBe(true);
    expect(sleepImpl).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

it("retries a timed-out health probe while the overall deadline still has time", async () => {
  const healthy = cancelTrackedFetchResponse(true);
  let probeSignal: AbortSignal | undefined;
  const now = vi.spyOn(performance, "now").mockReturnValue(100.25).mockReturnValueOnce(100);
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort());
  const fetchImpl = vi
    .fn<QaDockerFetchLike>(async () => healthy.response)
    .mockImplementationOnce(async (_input, init) => {
      probeSignal = init?.signal ?? undefined;
      if (!probeSignal) {
        throw new Error("health probe signal missing");
      }
      if (!probeSignal.aborted) {
        await once(probeSignal, "abort");
      }
      now.mockReturnValue(2100.25);
      throw new Error("health probe aborted");
    });
  const sleepImpl = mockAsync();

  try {
    await dockerRuntime().waitForHealth(healthUrl, {
      fetchImpl,
      sleepImpl,
      timeoutMs: 2_500,
      pollMs: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 2_000);
    expect(probeSignal?.aborted).toBe(true);
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(1);
    expect(healthy.cancel).toHaveBeenCalledOnce();
  } finally {
    timeout.mockRestore();
    now.mockRestore();
  }
});

it("resolves an unpinned QA Docker host port away from an occupied loopback default", async () => {
  const reservation = await occupyLoopbackPort();
  try {
    await expect(module.resolveQaDockerHostPort(reservation.port, true)).resolves.toBe(
      reservation.port,
    );
    const fallbackPort = await module.resolveQaDockerHostPort(reservation.port, false);
    expect(fallbackPort).toBeGreaterThan(0);
    expect(fallbackPort).not.toBe(reservation.port);
  } finally {
    await reservation.close();
  }
});

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

function installRunner<T extends ReturnType<typeof registration>>(entry: T, declared = plugin()) {
  loadPluginManifestRegistryCore.mockReturnValue(registry([declared]));
  surface({ qaRunnerCliRegistrations: [entry] });
  return entry;
}

function contribution(entry?: ReturnType<typeof registration>) {
  return {
    pluginId: "qa-example",
    commandName: "example",
    status: entry ? "available" : "blocked",
    ...(entry ? { registration: entry } : {}),
  };
}

function privateEnv(sourceRoot: string) {
  return expect.objectContaining({
    OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sourceRoot, "extensions"),
  });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function makePrivateQaSourceRoot(prefix: string) {
  const root = tempDirs.make(prefix);
  for (const dir of ["src", "extensions"]) {
    fs.mkdirSync(path.join(root, dir));
  }
  fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/mock\n");
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
  resolveOpenClawPackageRootSync.mockReturnValue(root);
  return root;
}

describe("QA runner discovery", () => {
  it.each([false, true])("loads the QA Lab surface with private source mode=%s", (privateMode) => {
    const sourceRoot = privateMode ? makePrivateQaSourceRoot("qa-runtime-root-") : undefined;
    const runtime = { defaultQaRuntimeModelForMode: vi.fn(), createQaLiveLaneGateway: vi.fn() };
    surface(runtime);
    expect(runner.loadQaRuntimeModule()).toBe(runtime);
    expectSurface("qa-lab", "runtime-api.js", sourceRoot);
  });
  it("loads bundled plugin test APIs with the private QA source tree override", async () => {
    const sourceRoot = makePrivateQaSourceRoot("openclaw-qa-test-api-root-");

    const testApi = { marker: "matrix-test-api" };
    surface(testApi);

    expect(runner.loadQaRunnerBundledPluginTestApi("matrix")).toBe(testApi);
    expectSurface("matrix", "test-api.js", sourceRoot);
  });

  it("reports the qa runtime as unavailable when the qa-lab surface is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
    });

    expect(runner.isQaRuntimeAvailable()).toBe(false);
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
    const registered = installRunner({ ...entry, adapterFactory }, declared);

    expect(listContributions()).toEqual([
      { ...contribution(registered), description: "Run the example live QA lane" },
    ]);
    expectSurface("qa-example", "qa-runner-api.js");
  });

  it("rejects invalid module-flow support metadata", async () => {
    const entry = registration();
    installRunner({
      ...entry,
      adapterFactory: { ...entry.adapterFactory, supportsModuleFlows: false },
    });

    expect(listContributions).toThrow(
      'QA runner plugin "qa-example" exported an invalid transport factory for "example"',
    );
  });

  it("reports declared runners as blocked when the plugin is present but not activated", async () => {
    loadPluginManifestRegistryCore.mockReturnValue(registry([plugin("workspace")]));
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

    expect(listContributions()).toEqual([contribution()]);
  });

  it("prefers the source bundled tree for private qa discovery in repo checkouts", async () => {
    const sourceRoot = makePrivateQaSourceRoot("openclaw-qa-runner-root-");

    const entry = registration();
    loadBundledPluginManifestRegistry.mockReturnValue(
      registry([plugin("bundled", path.join(sourceRoot, "extensions", "qa-example"))]),
    );
    surface({ qaRunnerCliRegistrations: [entry] });
    expect(listContributions()).toEqual([contribution(entry)]);
    expect(loadBundledPluginManifestRegistry.mock.calls[0]?.[0]).toMatchObject({
      env: privateEnv(sourceRoot),
    });
    expectSurface("qa-example", "qa-runner-api.js", sourceRoot);
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
    surface(null);

    expect(listContributions).toThrow(
      'QA runner command "matrix" declared by both "alpha" and "beta"',
    );
  });

  it("fails when runtime registrations include an undeclared command", async () => {
    loadPluginManifestRegistryCore.mockReturnValue(registry());
    surface({
      qaRunnerCliRegistrations: [registration(), { commandName: "extra", register: vi.fn() }],
    });

    expect(listContributions).toThrow(
      'QA runner plugin "qa-example" exported "extra" from its QA runner surface but did not declare it in openclaw.plugin.json',
    );
  });
});
