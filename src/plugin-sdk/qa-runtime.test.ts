import { createServer } from "node:net";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { LiveTransportQaCliRegistrationOptions } from "./qa-runtime.js";
import { restorePrivateQaCliEnv } from "./qa-runtime.test-helpers.js";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

describe("plugin-sdk qa-runtime", () => {
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

  beforeAll(() => {
    vi.resetModules();
  });

  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restorePrivateQaCliEnv(originalPrivateQaCli);
    if (originalBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
    }
  });

  async function occupyLoopbackPort(): Promise<{ close: () => Promise<void>; port: number }> {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server address unavailable"));
          return;
        }
        resolve(address.port);
      });
    });
    return {
      port,
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      },
    };
  }

  async function dockerRuntime() {
    const module = await import("./qa-runtime.js");
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

  it("reports the runtime as unavailable when the qa-lab surface is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
    });

    const module = await import("./qa-runtime.js");

    expect(module.isQaRuntimeAvailable()).toBe(false);
  });

  it("rethrows non-absence loader failures that mention the qa-lab runtime path", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Failed to evaluate qa-lab/runtime-api.js: invalid runtime export");
    });

    const module = await import("./qa-runtime.js");

    expect(() => module.isQaRuntimeAvailable()).toThrow(
      "Failed to evaluate qa-lab/runtime-api.js: invalid runtime export",
    );
  });

  it("runs a plugin-owned transport through the private QA suite host", async () => {
    const runLiveTransportQaSuiteCommand = vi.fn(async () => {});
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      runLiveTransportQaSuiteCommand,
    });
    const module = await import("./qa-runtime.js");
    const options = { providerMode: "mock-openai" };
    const selectScenarioIds = vi.fn(() => ["channel-canary"]);

    await module.runLiveTransportQaSuiteCommand({
      channelId: "buzz",
      defaultProviderMode: "mock-openai",
      options,
      selectScenarioIds,
    });

    expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith({
      channelId: "buzz",
      defaultProviderMode: "mock-openai",
      options,
      selectScenarioIds,
    });
  });

  it("registers shared live transport QA CLI options", async () => {
    const module = await import("./qa-runtime.js");
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

    await qa.parseAsync([
      "node",
      "openclaw",
      "telegram",
      ...[
        ["--repo-root", "/tmp/repo"],
        ["--output-dir", ".artifacts/qa"],
        ["--provider-mode", "mock-openai"],
        ["--model", "primary"],
        ["--alt-model", "alternate"],
        ["--scenario", "alpha"],
        ["--scenario", "  "],
        ["--scenario", "beta"],
        ["--profile", "fast"],
        ["--sut-account", "sut-2"],
        ["--credential-file", "/secure/telegram-qa.json"],
        ["--credential-source", "convex"],
        ["--credential-role", "maintainer"],
      ].flat(),
      "--fast",
      "--allow-failures",
      "--list-scenarios",
      "--fail-fast",
    ]);

    expect(run).toHaveBeenCalledWith({
      repoRoot: "/tmp/repo",
      outputDir: ".artifacts/qa",
      providerMode: "mock-openai",
      primaryModel: "primary",
      alternateModel: "alternate",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      profile: "fast",
      scenarioIds: ["alpha", "beta"],
      listScenarios: true,
      sutAccountId: "sut-2",
      credentialFile: "/secure/telegram-qa.json",
      credentialSource: "convex",
      credentialRole: "maintainer",
    });
  });

  it("reports a blank dedicated QA scenario selection without dispatching", async () => {
    const module = await import("./qa-runtime.js");
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
    const fetchImpl = vi.fn(
      async (_input: string, init?: Pick<RequestInit, "signal">) =>
        await new Promise<never>((_resolve, reject) => {
          probeSignal = init?.signal ?? undefined;
          if (!probeSignal) {
            reject(new Error("health probe signal missing"));
            return;
          }
          const rejectAborted = () => reject(new Error("health probe aborted"));
          if (probeSignal.aborted) {
            rejectAborted();
            return;
          }
          probeSignal.addEventListener("abort", rejectAborted, { once: true });
        }),
    );
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
    const module = await import("./qa-runtime.js");
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
});
