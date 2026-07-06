import { createServer } from "node:net";
/**
 * Tests QA runtime command loading and private CLI gating.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  expectPrivateQaLabRuntimeSurfaceLoad,
  expectQaLabRuntimeSurfaceLoad,
  restorePrivateQaCliEnv,
} from "./qa-runtime.test-helpers.js";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

describe("plugin-sdk qa-runtime", () => {
  const tempDirs: string[] = [];
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

  beforeEach(() => {
    vi.resetModules();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  });

  afterEach(() => {
    cleanupTempDirs(tempDirs);
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

  function cancelTrackedFetchResponse(ok = true) {
    let canceled = false;
    return {
      response: {
        ok,
        body: {
          cancel: vi.fn(async () => {
            canceled = true;
          }),
        },
      },
      wasCanceled: () => canceled,
    };
  }

  it("stays cold until the runtime seam is used", async () => {
    const module = await import("./qa-runtime.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(module.loadQaRuntimeModule).toBeTypeOf("function");
    expect(module.isQaRuntimeAvailable).toBeTypeOf("function");
  });

  it("loads the qa-lab runtime public surface through the generic seam", async () => {
    await expectQaLabRuntimeSurfaceLoad({
      importRuntime: () => import("./qa-runtime.js"),
      loadBundledPluginPublicSurfaceModuleSync,
    });
  });

  it("uses the source bundled tree for qa-lab runtime loading in private qa mode", async () => {
    await expectPrivateQaLabRuntimeSurfaceLoad({
      tempDirs,
      importRuntime: () => import("./qa-runtime.js"),
      loadBundledPluginPublicSurfaceModuleSync,
      resolveOpenClawPackageRootSync,
    });
  });

  it("reports the runtime as unavailable when the qa-lab surface is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
    });

    const module = await import("./qa-runtime.js");

    expect(module.isQaRuntimeAvailable()).toBe(false);
  });

  it("renders shared QA markdown reports with multiline details", async () => {
    const module = await import("./qa-runtime.js");

    const report = module.renderQaMarkdownReport({
      title: "QA Report",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:02.000Z"),
      checks: [{ name: "preflight", status: "pass" }],
      scenarios: [
        {
          name: "transport reply",
          status: "fail",
          details: "line one\nline two",
          steps: [{ name: "send", status: "pass", details: "ok" }],
        },
      ],
      timeline: ["sent request"],
      notes: ["kept artifacts"],
    });

    expect(report).toContain("# QA Report");
    expect(report).toContain("- Duration ms: 2000");
    expect(report).toContain("- Passed: 1");
    expect(report).toContain("- Failed: 1");
    expect(report).toContain("```text\nline one\nline two\n```");
    expect(report).toContain("- [x] send");
    expect(report).toContain("## Timeline");
  });

  it("keeps shared live transport scenario coverage helpers ordered and strict", async () => {
    const module = await import("./qa-runtime.js");

    expect(module.LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
      "restart-resume",
    ]);

    const definitions = [
      { id: "alpha", timeoutMs: 1_000, title: "alpha" },
      { id: "beta", timeoutMs: 1_000, title: "beta" },
    ] as const;
    expect(
      module.selectLiveTransportScenarios({
        ids: ["beta"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toEqual([definitions[1]]);
    expect(() =>
      module.selectLiveTransportScenarios({
        ids: ["missing"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toThrow("unknown Demo QA scenario id(s): missing");

    const covered = module.collectLiveTransportStandardScenarioCoverage({
      alwaysOnStandardScenarioIds: ["canary"],
      scenarios: [
        { id: "scenario-1", standardId: "mention-gating", timeoutMs: 1_000, title: "mention" },
        {
          id: "scenario-2",
          standardId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention again",
        },
        { id: "scenario-3", standardId: "restart-resume", timeoutMs: 1_000, title: "restart" },
      ],
    });
    expect(covered).toEqual(["canary", "mention-gating", "restart-resume"]);
    expect(
      module.findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: covered,
        expectedStandardScenarioIds: module.LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape"]);
  });

  it("registers shared live transport QA CLI options", async () => {
    const module = await import("./qa-runtime.js");
    const run = vi.fn(async () => {});
    const qa = new Command();

    module
      .createLiveTransportQaCliRegistration({
        commandName: "telegram",
        credentialOptions: {
          sourceDescription: "Credential source for Telegram QA",
          roleDescription: "Credential role for Telegram QA",
        },
        defaultProviderMode: "live-frontier",
        description: "Run Telegram QA",
        providerModeHelp: "Provider mode",
        listScenariosHelp: "List Telegram scenarios",
        outputDirHelp: "Telegram output directory",
        profileHelp: "QA profile",
        failFastHelp: "Stop after first failure",
        allowFailuresHelp: "Allow failures",
        scenarioHelp: "Run only the named scenario",
        sutAccountHelp: "Temporary SUT account",
        run,
      })
      .register(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "telegram",
      "--repo-root",
      "/tmp/repo",
      "--output-dir",
      ".artifacts/qa",
      "--provider-mode",
      "mock-openai",
      "--model",
      "primary",
      "--alt-model",
      "alternate",
      "--scenario",
      "alpha",
      "--scenario",
      "  ",
      "--scenario",
      "beta",
      "--fast",
      "--allow-failures",
      "--list-scenarios",
      "--profile",
      "fast",
      "--fail-fast",
      "--sut-account",
      "sut-2",
      "--credential-source",
      "convex",
      "--credential-role",
      "maintainer",
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
      credentialSource: "convex",
      credentialRole: "maintainer",
    });
  });

  it("builds shared live-lane artifact errors", async () => {
    const module = await import("./qa-runtime.js");

    expect(
      module.buildQaLiveLaneArtifactsError({
        heading: "Matrix QA failed.",
        details: ["cleanup: ok"],
        artifacts: {
          report: "/tmp/report.md",
          summary: "/tmp/summary.json",
        },
      }),
    ).toBe(
      [
        "Matrix QA failed.",
        "cleanup: ok",
        "Artifacts:",
        "- report: /tmp/report.md",
        "- summary: /tmp/summary.json",
      ].join("\n"),
    );
  });

  it("shares Docker health parsing across array and jsonl compose output", async () => {
    const module = await import("./qa-runtime.js");
    const runtime = module.createQaDockerRuntime({ auditContext: "qa-test" });
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

  it("normalizes multiline Docker compose service lookup output", async () => {
    const module = await import("./qa-runtime.js");
    const runtime = module.createQaDockerRuntime({ auditContext: "qa-test" });
    const runCommand = vi.fn(async (command: string, args: string[], cwd: string) => {
      expect(command).toBe("docker");
      expect(cwd).toBe("/repo");

      if (args.includes("ps") && args.includes("-q")) {
        return {
          stdout: "\nqa-gateway-one\nqa-gateway-two\n",
          stderr: "",
        };
      }

      if (args[0] === "inspect") {
        expect(args.at(-1)).toBe("qa-gateway-one");
        return {
          stdout: "\n172.18.0.4\n172.19.0.4\n",
          stderr: "",
        };
      }

      throw new Error(`unexpected docker args: ${args.join(" ")}`);
    });
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: url === "http://172.18.0.4:18789/healthz",
    }));

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

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith("http://172.18.0.4:18789/healthz");
  });

  it("cancels compose service health probe response bodies", async () => {
    const module = await import("./qa-runtime.js");
    const runtime = module.createQaDockerRuntime({ auditContext: "qa-test" });
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
    expect(probe.wasCanceled()).toBe(true);
  });

  it("cancels waitForHealth response bodies after each probe", async () => {
    const module = await import("./qa-runtime.js");
    const runtime = module.createQaDockerRuntime({ auditContext: "qa-test" });
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
    expect(first.wasCanceled()).toBe(true);
    expect(second.wasCanceled()).toBe(true);
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
