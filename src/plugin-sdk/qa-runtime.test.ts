import { once } from "node:events";
import { createServer } from "node:net";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { LiveTransportQaCliRegistrationOptions } from "./qa-runtime.js";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

beforeAll(() => {
  vi.resetModules();
});

let module: typeof import("./qa-runtime.js");
beforeEach(async () => {
  loadBundledPluginPublicSurfaceModuleSync.mockReset();
  resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
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

async function dockerRuntime() {
  return module.createQaDockerRuntime({ auditContext: "qa-test" });
}

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
  const runLiveTransportQaSuiteCommand = vi.fn(async () => {});
  loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
    runLiveTransportQaSuiteCommand,
  });
  const options = { providerMode: "mock-openai" };
  const selectScenarioIds = vi.fn(() => ["channel-canary"]);

  const request = {
    channelId: "buzz",
    defaultProviderMode: "mock-openai",
    options,
    selectScenarioIds,
  };
  await module.runLiveTransportQaSuiteCommand(request);
  expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith(request);
});

it("registers shared live transport QA CLI options", async () => {
  const run = vi.fn(async () => {});
  const qa = new Command();

  module
    .createLiveTransportQaCliRegistration({
      ...registrationOptions(run),
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
    })
    .register(qa);

  await qa.parseAsync(["node", "openclaw", "telegram"]);
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
  await qa.parseAsync([
    "node",
    "openclaw",
    "telegram",
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
  const qa = new Command();
  const dispatchedScenarioIds: string[][] = [];
  module
    .createLiveTransportQaCliRegistration(
      registrationOptions(async (options) => {
        dispatchedScenarioIds.push(options.scenarioIds ?? []);
      }),
    )
    .register(qa);

  const previousExitCode = process.exitCode;
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await qa.parseAsync(["node", "openclaw", "telegram", "--scenario", " \t "]);

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
  const runtime = await dockerRuntime();
  const dockerPsOutputs = ['[{"Health":"starting"}]', '{"State":"running"}\n'];
  const runCommand = vi.fn(async () => ({
    stdout: dockerPsOutputs.shift() ?? '{"State":"running"}',
    stderr: "",
  }));
  const sleepImpl = vi.fn(async () => {});

  await runtime.waitForDockerServiceHealth(
    "homeserver",
    "/tmp/docker-compose.yml",
    "/repo",
    runCommand,
    sleepImpl,
  );

  expect(runCommand).toHaveBeenCalledTimes(2);
  expect(sleepImpl).toHaveBeenCalledTimes(1);
});

it("cancels compose service health probe response bodies", async () => {
  const runtime = await dockerRuntime();
  const runCommand = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes("ps")) {
      return { stdout: "qa-gateway-one\n", stderr: "" };
    }
    return { stdout: "172.18.0.4\n", stderr: "" };
  });
  const probe = cancelTrackedFetchResponse(true);
  const fetchImpl = vi.fn(async () => probe.response);

  await expect(
    runtime.resolveComposeServiceUrl(
      "gateway",
      18789,
      "/tmp/docker-compose.yml",
      "/repo",
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
  const runtime = await dockerRuntime();

  await expect(runtime.fetchHealthUrl("http://127.0.0.1:18789/healthz")).resolves.toEqual({
    ok: false,
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels waitForHealth response bodies after each probe", async () => {
  const runtime = await dockerRuntime();
  const first = cancelTrackedFetchResponse(false);
  const second = cancelTrackedFetchResponse(true);
  const responses = [first.response, second.response];
  const fetchImpl = vi.fn(async () => responses.shift() ?? second.response);
  const sleepImpl = vi.fn(async () => {});

  await runtime.waitForHealth("http://127.0.0.1:18789/healthz", {
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
  const runtime = await dockerRuntime();
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
  const sleepImpl = vi.fn(async () => {});
  const startedAt = Date.now();

  await expect(
    runtime.waitForHealth("http://127.0.0.1:18789/healthz", {
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
