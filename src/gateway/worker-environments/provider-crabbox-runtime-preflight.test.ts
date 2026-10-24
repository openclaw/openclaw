import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginApi, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { importFreshModule } from "../../plugin-sdk/test-helpers/import-fresh.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginStateKeyedStoreV2 } from "../../plugin-state/plugin-state-store.js";
import { resolvePluginModuleExport } from "../../plugins/module-export.js";
import * as support from "./service.test-support.js";

const CLASSLESS_PROFILE = {
  binary: "/mock/crabbox",
  provider: "machine0",
  ttl: "24h",
  idleTimeout: "60m",
  setup: "true",
};
const PROFILE = { ...CLASSLESS_PROFILE, class: "standard" };

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("Crabbox runtime preflight cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();
  const pluginServices: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  let scheduler: ReturnType<typeof createTestPluginServiceScheduler>;
  async function registerProvider(): Promise<WorkerProvider> {
    let registered: WorkerProvider | undefined;
    const { register } = resolvePluginModuleExport(
      await importFreshModule<unknown>(import.meta.url, "../../../extensions/crabbox/index.ts"),
    );
    expectDefined(
      register,
      "Crabbox plugin registration",
    )(
      createTestPluginApi({
        id: "crabbox",
        runtime: createPluginRuntimeMock({
          state: {
            openKeyedStoreV2: (options) =>
              createPluginStateKeyedStoreV2("crabbox", options, { assertCurrent() {} }),
          },
        }),
        rootDir: fileURLToPath(new URL("../../../extensions/crabbox/", import.meta.url)),
        registerWorkerProvider: (provider) => {
          registered = provider;
        },
        registerService: (service) => {
          pluginServices.push(service);
        },
      }),
    );
    return expectDefined(registered, "registered Crabbox provider");
  }
  beforeEach(() => {
    scheduler = createTestPluginServiceScheduler();
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
  });
  afterEach(async () => {
    scheduler.beginClose();
    try {
      for (const service of pluginServices.splice(0)) {
        await service.stop?.({
          scheduler,
          config: support.testState.config,
          stateDir: support.testState.root,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
      }
    } finally {
      await scheduler.stop();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reclaims after Crabbox accepts stop while retaining waiting-stop release confirmation", async ({
    signal,
  }) => {
    const environmentId = "worker-fast-reclaim";
    const leaseId = "cbx_0123456789ab";
    const acceptedStop = createDeferred();
    const finishRelease = createDeferred();
    const calls: string[][] = [];
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "999.0.0" });
      }
      calls.push(argv);
      expect(argv[1]).toBe("stop");
      if (argv.includes("--wait=false")) {
        acceptedStop.resolve();
      } else {
        await withinTest(finishRelease.promise, signal);
      }
      return commandResult();
    });
    const provider = await registerProvider();
    // Seed the real persisted provider snapshot without allocating any cloud resource.
    const intent = await support.testState.store.createIntent({
      environmentId,
      providerId: "crabbox",
      profileId: "development",
      profileSnapshot: {
        settings: { ...PROFILE, provider: "aws", warmImage: false },
      },
      provisionOperationId: "fast-reclaim-operation",
    });
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    await support.testState.store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId, sshEndpoint: support.SSH_ENDPOINT },
    });
    await support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(intent.environmentId),
    });
    const service = support.createService(provider);
    const reclaim = service.reclaim(intent.environmentId);
    try {
      await withinTest(acceptedStop.promise, signal);
      await expect(withinTest(reclaim, signal)).resolves.toMatchObject({ state: "destroying" });
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "destroying",
        leaseId,
      });
      finishRelease.resolve();
      await expect(service.destroy(intent.environmentId)).resolves.toMatchObject({
        state: "destroyed",
      });
      expect(calls.map((argv) => argv.slice(1))).toEqual([
        ["stop", "--provider", "aws", "--id", leaseId, "--wait=false"],
        ["stop", "--provider", "aws", "--id", leaseId],
      ]);
    } finally {
      finishRelease.resolve();
      await reclaim;
    }
  });

  it.each(["spawn", "config"])(
    "settles fresh %s preflight failure without inventing a provider cleanup obligation",
    async (failure) => {
      support.getDevelopmentProfile().provider = "crabbox";
      support.getDevelopmentProfile().settings = { ...PROFILE, provider: "aws" };
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          if (argv[1] === "--version") {
            expect(argv.slice(1)).toEqual(["--version"]);
            return commandResult({ stdout: "999.0.0" });
          }
          if (argv[1] === "providers") {
            expect(argv.slice(1)).toEqual(["providers", "--json"]);
            return commandResult({ stdout: "[]" });
          }
          expect(argv.slice(1)).toEqual(["config", "show", "--json"]);
          if (failure === "spawn") {
            throw new Error("synthetic executable could not start");
          }
          return commandResult({ code: 2, stderr: "synthetic config preflight failure" });
        });
      const service = support.createService(await registerProvider(), {
        prepareNodeEnrollment: vi.fn(),
      });
      await expect(
        service.createWithRequest({ profileId: "development", idempotencyKey: "fresh-preflight" }),
      ).rejects.toMatchObject({
        code: "provider_failure",
      });
      const failed = expectDefined(support.testState.store.list()[0], "failed fresh intent");
      expect(failed).toMatchObject({ state: "failed", leaseId: null, destroyRequestedAtMs: null });
      await expect(service.destroy(failed.environmentId)).resolves.toMatchObject({
        state: "failed",
        leaseId: null,
      });
      await support.reopenWorkerEnvironmentStore();
      const restarted = support.createService(await registerProvider(), {
        prepareNodeEnrollment: vi.fn(),
      });
      await restarted.reconcileOnce();
      expect(support.testState.store.get(failed.environmentId)).toEqual(failed);
      expect(runCommand.mock.calls.map(([argv]) => argv.slice(1))).toEqual([
        ["--version"],
        ["providers", "--json"],
        ["config", "show", "--json"],
      ]);
    },
  );

  it.each([
    { diagnostic: "provider=linode does not support fixed idempotent lease IDs", refused: true },
    { diagnostic: "provider=linode allocation response lost", refused: false },
    { diagnostic: "provider=scaleway does not support fixed idempotent lease IDs", refused: false },
    {
      diagnostic: "provider=linode does not support fixed idempotent lease IDs\nallocation pending",
      refused: false,
    },
  ])(
    "retains cleanup only for ambiguous warmup failure: $diagnostic",
    async ({ diagnostic, refused }) => {
      support.getDevelopmentProfile().provider = "crabbox";
      support.getDevelopmentProfile().settings = {
        ...PROFILE,
        provider: "linode",
        warmImage: false,
      };
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          if (argv[1] === "--version") {
            return commandResult({ stdout: "999.0.0" });
          }
          if (argv[1] === "providers") {
            return commandResult({ stdout: "[]" });
          }
          if (argv[1] === "warmup") {
            return commandResult({ code: 2, stderr: diagnostic });
          }
          return commandResult({ code: 1, stderr: "lease has no local claim" });
        });
      const service = support.createService(await registerProvider(), {
        prepareNodeEnrollment: vi.fn(),
      });
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "unsupported-fixed-id",
        }),
      ).rejects.toMatchObject({
        code: refused ? "invalid_profile" : "provider_failure",
        message: expect.stringContaining(
          refused
            ? "OpenClaw cloud workers need a Crabbox backend with fixed lease ID support"
            : diagnostic.replaceAll("\n", " "),
        ),
      });
      const record = expectDefined(support.testState.store.list()[0], "warmup failure record");
      expect(record).toMatchObject({
        state: refused ? "failed" : "provisioning",
        leaseId: null,
        destroyRequestedAtMs: null,
      });
      if (refused) {
        await service.reconcileOnce();
        await expect(service.destroy(record.environmentId)).resolves.toMatchObject({
          state: "failed",
        });
        expect(
          runCommand.mock.calls.some(([argv]) => argv[1] === "stop" || argv[1] === "inspect"),
        ).toBe(false);
      } else {
        await expect(service.destroy(record.environmentId)).rejects.toMatchObject({
          code: "provider_failure",
        });
        expect(service.get(record.environmentId)).toMatchObject({
          state: "destroying",
          destroyRequestedAtMs: expect.any(Number),
        });
        expect(runCommand.mock.calls.some(([argv]) => argv[1] === "stop")).toBe(true);
      }
    },
  );

  it.each([
    {
      name: "terminal fixed lease",
      backend: "digitalocean",
      code: 4,
      stderr: "DigitalOcean fixed lease is terminal",
      attached: false,
      outcome: "destroyed",
    },
    {
      name: "absent attached resource",
      backend: "ascii-box",
      code: 1,
      stderr: "ascii-box bx_0123456789ab not found (404)",
      attached: true,
      outcome: "destroyed",
    },
    {
      name: "absent resource with unconfirmed stop",
      backend: "ascii-box",
      code: 1,
      stderr: "ascii-box bx_0123456789ab not found (404)",
      attached: true,
      outcome: "retry-stop",
    },
    {
      name: "unresolved creation attempt",
      backend: "digitalocean",
      code: 4,
      stderr:
        "lease_id_conflict: lease cbx_0123456789ab has an unresolved or unattested creation attempt",
      attached: false,
      outcome: "retry-inspect",
    },
    {
      name: "terminal text with an unexpected exit code",
      backend: "digitalocean",
      code: 1,
      stderr: "DigitalOcean fixed lease is terminal",
      attached: false,
      outcome: "retry-inspect",
    },
    {
      name: "not-found text mixed with an auth failure",
      backend: "ascii-box",
      code: 1,
      stderr: "ascii-box bx_0123456789ab not found (404)\nauthentication failed",
      attached: false,
      outcome: "retry-inspect",
    },
  ])("reconciles requested teardown after $name", async (scenario) => {
    const environmentId = "worker-inspect-cleanup";
    const leaseId = "cbx_0123456789ab";
    const intent = await support.testState.store.createIntent({
      environmentId,
      providerId: "crabbox",
      profileId: "development",
      profileSnapshot: {
        executionMode: "worker-turn",
        settings: { ...PROFILE, provider: scenario.backend, warmImage: false },
      },
      provisionOperationId: `provision:${"0".repeat(64)}`,
    });
    await support.testState.store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    let record = await support.testState.store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId,
        nodeDeviceId: "node:cleanup-fixture",
        sharedHost: false,
        ...support.readyPatch(environmentId),
      },
    });
    if (scenario.attached) {
      record = await support.testState.store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, "session-cleanup-fixture"),
      });
    }
    await support.testState.store.requestDestroy({ environmentId, state: record.state });
    if (!scenario.attached) {
      await support.testState.store.transition({ environmentId, from: "ready", to: "draining" });
      record = await support.testState.store.transition({
        environmentId,
        from: "draining",
        to: "destroying",
      });
    }
    let stopFails = scenario.outcome === "retry-stop";
    const calls: string[][] = [];
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "999.0.0" });
      }
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ code: scenario.code, stderr: scenario.stderr });
      }
      expect(argv[1]).toBe("stop");
      return stopFails
        ? commandResult({ code: 1, stderr: "synthetic provider stop unavailable" })
        : commandResult();
    });
    const service = support.createService(await registerProvider());
    const inspectCommand = [
      PROFILE.binary,
      "inspect",
      "--provider",
      scenario.backend,
      "--network",
      "public",
      "--id",
      leaseId,
      "--json",
    ];
    const stopCommand = [PROFILE.binary, "stop", "--provider", scenario.backend, "--id", leaseId];

    await service.reconcileOnce();

    if (scenario.outcome === "retry-inspect") {
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "destroying",
        leaseId,
        lastError: expect.stringContaining("Crabbox inspect failed"),
      });
      await service.reconcileOnce();
      expect(calls).toEqual([inspectCommand, inspectCommand]);
      return;
    }
    expect(calls).toEqual([inspectCommand, stopCommand]);
    if (stopFails) {
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "attached",
        leaseId,
        ownerEpoch: record.ownerEpoch,
        attachedSessionIds: ["session-cleanup-fixture"],
        lastError: expect.stringContaining("synthetic provider stop unavailable"),
      });
      stopFails = false;
      await service.reconcileOnce();
      expect(calls).toEqual([inspectCommand, stopCommand, inspectCommand, stopCommand]);
    }
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId,
      attachedSessionIds: [],
      teardownTerminalState: "destroyed",
    });
    const settledCallCount = calls.length;
    await service.reconcileOnce();
    expect(calls).toHaveLength(settledCallCount);
  });

  it.each(["restart reconciliation", "direct destroy"])(
    "retains unresolved legacy allocation responsibility after %s and cleanup restart",
    async (entrance) => {
      const intent = await support.testState.store.createIntent({
        environmentId: "worker-legacy-provision",
        providerId: "crabbox",
        profileId: "development",
        profileSnapshot: { settings: PROFILE },
        provisionOperationId: `provision:${"0".repeat(64)}`,
      });
      const original = await support.testState.store.transition({
        environmentId: intent.environmentId,
        from: intent.state,
        to: "provisioning",
      });
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async () => {
          throw new Error("legacy allocation must not invoke Crabbox");
        });
      const prepareNodeEnrollment = vi.fn();
      await support.reopenWorkerEnvironmentStore();
      const provider = await registerProvider();
      const provision = vi.spyOn(provider, "prepareProvision");
      const resolveAllocation = vi.spyOn(provider, "resolveAllocation");
      let service = support.createService(provider, { prepareNodeEnrollment });
      if (entrance === "restart reconciliation") {
        await service.reconcileOnce();
        expect(provision).toHaveBeenCalledOnce();
        expect.soft(support.testState.store.get(original.environmentId)).toMatchObject({
          ...original,
          lastError: expect.stringContaining("cannot be replayed safely"),
        });
      }
      await expect(service.destroy(original.environmentId)).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(
        service.get(original.environmentId),
        "unresolved legacy cleanup",
      );
      expect(pending).toMatchObject({
        ...original,
        destroyRequestedAtMs: support.testState.nowMs,
        teardownTerminalState: "destroyed",
        lastError: expect.stringContaining("cannot be replayed safely"),
      });
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
        PROFILE,
        original.provisionOperationId,
      );
      expect(provision).toHaveBeenCalledTimes(entrance === "restart reconciliation" ? 1 : 0);

      await support.reopenWorkerEnvironmentStore();
      const restartedProvider = await registerProvider();
      const restartedProvision = vi.spyOn(restartedProvider, "prepareProvision");
      const restartedResolution = vi.spyOn(restartedProvider, "resolveAllocation");
      service = support.createService(restartedProvider, { prepareNodeEnrollment });
      await service.reconcileOnce();
      await expect(service.destroy(original.environmentId)).rejects.toMatchObject({
        code: "provider_failure",
      });
      expect(service.get(original.environmentId)).toEqual(pending);
      expect(restartedResolution.mock.calls).toEqual([
        [PROFILE, original.provisionOperationId],
        [PROFILE, original.provisionOperationId],
      ]);
      expect(restartedProvision).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expect(prepareNodeEnrollment).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(support.testState.store.getCredential(original.environmentId)).toBeUndefined();
    },
  );

  // Synthetic CLI diagnostics exercise the real error producer, not captured native output.
  it.each([
    { kind: "config", name: "config command failure", result: commandResult({ code: 2 }) },
    { kind: "config", name: "invalid config JSON", result: commandResult({ stdout: "{" }) },
    { kind: "config", name: "removed coordinator", result: commandResult({ stdout: "{}" }) },
    {
      kind: "aws-profile",
      name: "attached AWS profile",
      result: commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "new-role" } }) }),
    },
    { kind: "modes", name: "changed advertised modes" },
    { kind: "timeout", name: "invalid timeout metadata" },
    {
      kind: "cli",
      name: "unknown flag: --lease-id",
      result: commandResult({ code: 2, stderr: "unknown flag: --lease-id" }),
    },
    {
      kind: "cli",
      name: "fixed-ID capability removed after allocation",
      result: commandResult({
        code: 2,
        stderr: "provider=machine0 does not support fixed idempotent lease IDs",
      }),
    },
  ])("retains the original allocation after $name across restart", async (scenario) => {
    const profile = {
      ...PROFILE,
      ...(scenario.kind === "config" ? { provider: "hetzner", desktop: true } : {}),
      ...(scenario.kind === "aws-profile" ? { provider: "aws" } : {}),
    };
    support.getDevelopmentProfile().provider = "crabbox";
    support.getDevelopmentProfile().settings = profile;
    // This replay fixture owns lifecycle commands; periodic heartbeats have separate coverage.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let changed = false;
    let live = false;
    let leaseId = "";
    let allocations = 0;
    let stops = 0;
    const calls: string[][] = [];
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        expect(argv.slice(1)).toEqual(["--version"]);
        return commandResult({ stdout: "999.0.0" });
      }
      calls.push(argv);
      if (argv[1] === "providers") {
        expect(argv.slice(1)).toEqual(["providers", "--json"]);
        return commandResult({ stdout: "[]" });
      }
      if (argv[1] === "config") {
        return changed && "result" in scenario
          ? expectDefined(scenario.result, "runtime refusal")
          : commandResult({
              stdout: JSON.stringify({
                coordinator: "https://coordinator.example.test",
                brokerMode: "managed",
                aws: { instanceProfile: "" },
              }),
            });
      }
      if (argv[1] === "warmup") {
        if (changed && "result" in scenario) {
          return expectDefined(scenario.result, "runtime refusal");
        }
        allocations += 1;
        live = true;
        leaseId = expectDefined(argv[argv.indexOf("--lease-id") + 1], "original fixed lease");
        return commandResult({ code: 5, stderr: "synthetic response lost after allocation" });
      }
      expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
      if (argv[1] === "stop") {
        stops += 1;
        if (stops === 1) {
          return commandResult({ code: 4, stderr: `lease ${leaseId} already stopped` });
        }
        live = false;
        return commandResult();
      }
      expect(argv[1]).toBe("inspect");
      return commandResult({
        stdout: JSON.stringify({ id: leaseId, state: "running", ready: true }),
      });
    });
    const prepareNodeEnrollment = vi.fn();
    const makeProvider = async (): Promise<WorkerProvider> => {
      const provider = await registerProvider();
      if (changed && scenario.kind === "modes") {
        provider.supportedExecutionModes = ["remote-exec"];
      }
      if (changed && scenario.kind === "timeout") {
        provider.resolveProvisionTimeoutMs = () => Number.NaN;
      }
      return provider;
    };
    let service = support.createService(await makeProvider(), { prepareNodeEnrollment });
    await expect(
      service.createWithRequest({
        profileId: "development",
        idempotencyKey: "runtime-replay",
        executionMode: "worker-turn",
      }),
    ).rejects.toMatchObject({ code: "provider_failure" });
    const original = expectDefined(support.testState.store.list()[0], "unreported allocation");
    expect(original).toMatchObject({ state: "provisioning", leaseId: null });
    expect(live).toBe(true);

    await support.reopenWorkerEnvironmentStore();
    changed = true;
    const replayProvider = await makeProvider();
    const resolveAllocation = vi.spyOn(replayProvider, "resolveAllocation");
    service = support.createService(replayProvider, { prepareNodeEnrollment });
    await service.reconcileOnce();
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      provisionOperationId: original.provisionOperationId,
      profileSnapshot: original.profileSnapshot,
      lastError: expect.any(String),
    });
    const beforeCleanup = calls.length;
    support.testState.config.cloudWorkers!.profiles = {};
    await expect(service.destroy(original.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
      profile,
      original.provisionOperationId,
    );
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "destroying",
      leaseId,
      destroyRequestedAtMs: expect.any(Number),
    });
    expect(live).toBe(true);

    await support.reopenWorkerEnvironmentStore();
    service = support.createService(await makeProvider(), { prepareNodeEnrollment });
    await service.reconcileOnce();
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "destroyed",
      leaseId,
    });
    await service.destroy(original.environmentId);
    await service.reconcileOnce();
    expect(calls.slice(beforeCleanup).map((argv) => argv[1])).toEqual(["stop", "inspect", "stop"]);
    expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(
      scenario.kind === "cli" ? 2 : 1,
    );
    expect(allocations).toBe(1);
    expect(stops).toBe(2);
    expect(live).toBe(false);
    expect(prepareNodeEnrollment).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unrepaired plaintext setup environment",
      settings: { ...PROFILE, setupEnv: ["LEGACY_SETUP_TOKEN"] },
      message: "openclaw doctor --fix",
      commands: [],
      intentRecorded: false,
    },
    {
      name: "invalid duration",
      settings: { ...PROFILE, ttl: "invalid" },
      message: "positive Go duration",
      commands: [],
      intentRecorded: false,
    },
    {
      name: "warm image without effective class",
      settings: { ...CLASSLESS_PROFILE, warmImage: true },
      message: "warmImage requires a configured class or a placement machine class",
      commands: [["--version"], ["providers", "--json"]],
      intentRecorded: true,
    },
  ])(
    "keeps $name permanent before allocating a worker",
    async ({ settings, message, commands, intentRecorded }) => {
      support.getDevelopmentProfile().provider = "crabbox";
      support.getDevelopmentProfile().settings = settings;
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          if (argv[1] === "--version") {
            expect(argv.slice(1)).toEqual(["--version"]);
            return commandResult({ stdout: "999.0.0" });
          }
          expect(argv.slice(1)).toEqual(["providers", "--json"]);
          return commandResult({ stdout: "[]" });
        });
      const provider = await registerProvider();
      const service = support.createService(provider, { prepareNodeEnrollment: vi.fn() });
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "invalid-immutable",
        }),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: expect.stringContaining(message),
      });
      const records = support.testState.store.list();
      expect(records).toHaveLength(intentRecorded ? 1 : 0);
      if (intentRecorded) {
        expect(records[0]).toMatchObject({ state: "failed", leaseId: null });
      }
      await support.waitForFast(() =>
        expect(runCommand.mock.calls.map(([argv]) => argv.slice(1))).toEqual(commands),
      );
    },
  );
});
