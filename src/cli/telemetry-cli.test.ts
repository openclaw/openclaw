import { Command, CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerTelemetryCli } from "./telemetry-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    getRuntimeConfig: vi.fn(),
    transformConfigFileWithRetry: vi.fn(),
    buildTelemetryPayload: vi.fn(),
    buildTelemetryUserAgent: vi.fn(),
    resolveTelemetryStatus: vi.fn(),
  };
});

// mock-isolation: Telemetry fixtures capture config mutations without reading or writing operator state.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("../commands/test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "getRuntimeConfig"),
    transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
  };
});
vi.mock("../infra/telemetry.js", () => ({
  buildTelemetryPayload: mocks.buildTelemetryPayload,
  buildTelemetryUserAgent: mocks.buildTelemetryUserAgent,
  resolveTelemetryStatus: mocks.resolveTelemetryStatus,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));

const config: OpenClawConfig = {
  telemetry: { enabled: true, consentedAt: "2026-08-23T00:00:00.000Z" },
};
const endpoint = "https://telemetry.openclaw.ai/api/latest-version";
const userAgent = "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)";
const enabledStatus = {
  enabled: true,
  reason: "enabled" as const,
  endpoint,
  lastPingAt: Date.parse("2026-08-22T12:00:00.000Z"),
  installationCountEnabled: true,
};
const payload = {
  schema: 1,
  version: "2026.8.2",
  platform: "darwin-arm64",
  node: "26.0.1",
  surface: "gateway",
  features: {
    channels: ["discord", "telegram"],
    providerFamilies: ["anthropic", "openai"],
    pluginsEnabled: 7,
    sessionsLast24h: 14,
  },
};

function createTelemetryProgram() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command()
    .name("openclaw")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
    });
  registerTelemetryCli(program);
  return { program, stdout, stderr };
}

async function runTelemetryCli(args: string[]): Promise<void> {
  const { program } = createTelemetryProgram();
  await program.parseAsync(["telemetry", ...args], { from: "user" });
}

describe("telemetry cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.writeJson.mockImplementation(() => {});
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.buildTelemetryPayload.mockResolvedValue(payload);
    mocks.buildTelemetryUserAgent.mockReturnValue(userAgent);
    mocks.resolveTelemetryStatus.mockResolvedValue(enabledStatus);
  });

  it("prints exactly the canonical payload when feature statistics are enabled", async () => {
    await runTelemetryCli(["show"]);

    expect(mocks.buildTelemetryPayload).toHaveBeenCalledWith(config, { surface: "gateway" });
    expect(mocks.runtimeLogs).toContain(JSON.stringify(payload));
    expect(mocks.runtimeLogs).toContain("Feature stats: enabled");
    expect(mocks.runtimeLogs).toContain(
      "Installation counting: eligible after a fresh receiver capability",
    );
    expect(mocks.runtimeLogs).toContain("Last ping: 2026-08-22T12:00:00.000Z");
    expect(mocks.runtimeLogs).toContain(
      "Request: POST https://telemetry.openclaw.ai/api/latest-version",
    );
  });

  it("waits for status and payload before reporting one complete JSON document", async () => {
    const telemetryStatus =
      createDeferredCore<
        Awaited<ReturnType<typeof import("../infra/telemetry.js").resolveTelemetryStatus>>
      >();
    const telemetryPayload = createDeferredCore<typeof payload>();
    const statusRequested = createDeferredCore();
    const payloadRequested = createDeferredCore();
    mocks.resolveTelemetryStatus.mockImplementationOnce(() => {
      statusRequested.resolve();
      return telemetryStatus.promise;
    });
    mocks.buildTelemetryPayload.mockImplementationOnce(() => {
      payloadRequested.resolve();
      return telemetryPayload.promise;
    });

    const showing = runTelemetryCli(["show", "--json"]);
    await statusRequested.promise;
    expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();

    telemetryStatus.resolve(enabledStatus);
    await payloadRequested.promise;
    expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();

    telemetryPayload.resolve(payload);
    await showing;

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        featureStatsEnabled: true,
        installationCountEnabled: true,
        reason: "enabled",
        endpoint,
        lastPingAt: "2026-08-22T12:00:00.000Z",
        request: {
          method: "POST",
          userAgent,
          payload,
        },
      },
      0,
    );
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "never-asked",
      label: "consent has not been requested",
      method: "GET",
      installationCountEnabled: true,
    },
    {
      reason: "config-disabled",
      label: "disabled in configuration",
      method: "GET",
      installationCountEnabled: false,
    },
    {
      reason: "automated-environment",
      label: "disabled in an automated environment (CI is set)",
      method: null,
      installationCountEnabled: false,
    },
  ])(
    "reports the same request in JSON and text for $reason",
    async ({ reason, label, method, installationCountEnabled }) => {
      mocks.resolveTelemetryStatus.mockResolvedValue({
        enabled: false,
        reason,
        endpoint,
        installationCountEnabled,
      });

      await runTelemetryCli(["show", "--json"]);

      expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
        {
          featureStatsEnabled: false,
          installationCountEnabled,
          reason,
          endpoint,
          lastPingAt: null,
          request: method ? { method, userAgent } : null,
        },
        0,
      );
      expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
      await runTelemetryCli(["show"]);

      expect(mocks.buildTelemetryPayload).not.toHaveBeenCalled();
      expect(mocks.runtimeLogs).toEqual([
        "Feature stats: disabled",
        "Installation counting: " +
          (installationCountEnabled ? "eligible after a fresh receiver capability" : "disabled"),
        `Reason: ${label}`,
        `Endpoint: ${endpoint}`,
        "Last ping: never",
        ...(method
          ? [`Request: ${method} ${endpoint}`, `User-Agent: ${userAgent}`]
          : [`Request: none (${label})`]),
      ]);
    },
  );

  it.each([
    { command: "on", enabled: true },
    { command: "off", enabled: false },
  ])(
    "records operator consent when turning feature statistics $command",
    async ({ command, enabled }) => {
      const originalConfig: OpenClawConfig = {
        update: { checkOnStart: false },
        telemetry: { enabled: !enabled, consentedAt: "2025-01-01T00:00:00.000Z" },
      };
      mocks.transformConfigFileWithRetry.mockImplementationOnce(
        async (options: {
          transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig };
        }) => options.transform(originalConfig),
      );

      await runTelemetryCli([command]);

      const result = await mocks.transformConfigFileWithRetry.mock.results[0]?.value;
      expect(result.nextConfig).toMatchObject({
        update: { checkOnStart: false },
        telemetry: { enabled, consentedAt: expect.any(String) },
      });
      expect(Number.isNaN(Date.parse(result.nextConfig.telemetry.consentedAt))).toBe(false);
      expect(mocks.runtimeLogs).toContain(
        `Anonymous feature stats ${enabled ? "enabled" : "disabled"}.`,
      );
    },
  );

  it.each([
    { name: "parent help", args: [], mustThrow: false },
    { name: "implicit help", args: ["help"], mustThrow: true },
  ])("prints $name without reading or changing telemetry", async ({ args, mustThrow }) => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const { program, stdout, stderr } = createTelemetryProgram();
    try {
      let exitCode: number;
      let threw = false;
      try {
        await program.parseAsync(["telemetry", ...args], { from: "user" });
        exitCode = process.exitCode ?? 0;
      } catch (error) {
        if (mustThrow) {
          expect(error).toMatchObject({ exitCode: 0 });
          exitCode = 0;
        } else if (error instanceof CommanderError && error.code === "commander.help") {
          exitCode = error.exitCode;
        } else {
          throw error;
        }
        threw = true;
      }
      if (mustThrow) {
        expect(threw).toBe(true);
      }
      expect(exitCode).toEqual(0);
      expect(stdout.join("")).toContain("Usage: openclaw telemetry [options] [command]");
      expect(stdout.join("")).toContain("Inspect and manage anonymous usage telemetry");
      expect(stderr).toEqual([]);
      expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
