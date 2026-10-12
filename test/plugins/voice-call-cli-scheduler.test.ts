import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import voiceCallPlugin from "../../extensions/voice-call/index.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { LegacyPluginSdkResourceHost } from "../../src/plugins/legacy-sdk-resource-host.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { getPluginInstance } from "../../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../src/plugins/registry-runtime.test-helpers.js";
import type { PluginServiceSchedulerV1 } from "../../src/plugins/service-scheduler.types.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../src/test-utils/gateway-scheduler-clock.js";

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn(), callGateway: vi.fn() }));
vi.mock("../../extensions/voice-call/runtime-entry.js", () => ({
  createVoiceCallRuntime: mocks.createRuntime,
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: mocks.callGateway,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.createRuntime.mockReset();
  mocks.callGateway.mockReset();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.voice-call.runtimeCoordinator")
  ];
});

it.each([
  {
    name: "start prints JSON",
    args: ["voicecall", "start", "--to", "+1", "--message", "Hello"],
    config: { provider: "mock" },
    output: '"callId": "call-1"',
    to: "+1",
    options: { message: "Hello", mode: "conversation" },
  },
  {
    name: "smoke places a live notify call with --yes",
    args: ["voicecall", "smoke", "--to", "+15550009999", "--yes"],
    config: {
      provider: "twilio",
      fromNumber: "+15550001234",
      publicUrl: "https://voice.example.com/voice/webhook",
      twilio: { accountSid: "AC123", authToken: "token" },
    },
    output: "live-call: started call-1",
    to: "+15550009999",
    options: { message: "OpenClaw voice call smoke test.", mode: "notify" },
  },
])("Voice Call CLI $name with its registered owner", async (scenario) => {
  vi.stubEnv("OPENCLAW_CLI", "1");
  mocks.callGateway.mockRejectedValue(
    Object.assign(new Error("gateway transport failed"), {
      name: "GatewayTransportError",
      kind: "closed",
      connectionDetails: { url: "ws://127.0.0.1:18789" },
    }),
  );
  const clock = createGatewaySchedulerClock();
  const root = createTestGatewayScheduler(clock.clock);
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(root);
  const builder = createTestPluginRegistry(createPluginRuntimeMock());
  const record = createPluginRecord({
    id: "voice-call",
    source: "test",
    origin: "bundled",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, pluginConfig: scenario.config });
  const instance = getPluginInstance(record)!;
  const program = new Command();
  const printed = createDeferredCore();
  const stopping = createDeferredCore();
  const releaseStop = createDeferredCore();
  const initiateCall = vi.fn(async () => ({ success: true, callId: "call-1" }));
  const stop = vi.fn(async () => {
    stopping.resolve();
    await releaseStop.promise;
  });
  let scheduler: PluginServiceSchedulerV1 | undefined;
  mocks.createRuntime.mockImplementation(
    async (options: { scheduler: PluginServiceSchedulerV1 }) => {
      scheduler = options.scheduler;
      return {
        config: { toNumber: "+15550001234", realtime: { enabled: false } },
        manager: { initiateCall },
        stop,
      };
    },
  );
  const originalListeners = new Set(process.listeners("SIGTERM"));
  const originalExitCode = process.exitCode;
  let output = "";
  let command: Promise<Command> | undefined;
  let settled = false;
  const signalOwnedCommand = () => {
    for (const handler of process.listeners("SIGTERM")) {
      if (!originalListeners.has(handler)) {
        handler("SIGTERM");
      }
    }
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    if (output.includes(scenario.output)) {
      printed.resolve();
    }
    return true;
  }) as typeof process.stdout.write);
  try {
    host.run(() => voiceCallPlugin.register(api));
    await host.run(() =>
      builder.registry.cliRegistrars[0]!.register({
        program,
        parentPath: [],
        config: {},
        logger: api.logger,
      }),
    );
    command = program.parseAsync(scenario.args, { from: "user" });
    void command.then(
      () => {
        settled = true;
      },
      (error: unknown) => printed.reject(error),
    );
    await printed.promise;
    expect(output).toContain(scenario.output);
    expect(initiateCall).toHaveBeenCalledWith(scenario.to, undefined, scenario.options);
    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(scheduler?.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(
      process.listeners("SIGTERM").filter((handler) => !originalListeners.has(handler)),
    ).toHaveLength(1);
    signalOwnedCommand();
    await stopping.promise;
    expect(settled).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    releaseStop.resolve();
    await command;
    expect(process.exitCode).toBe(143);
    expect(process.listeners("SIGTERM")).toEqual([...originalListeners]);
    await host.close();
    expect(scheduler?.signal.aborted).toBe(true);
  } finally {
    signalOwnedCommand();
    releaseStop.resolve();
    await command?.catch(() => undefined);
    stdout.mockRestore();
    process.exitCode = originalExitCode;
    await root.stop();
    await host.close();
    await instance.dispose();
  }
});
