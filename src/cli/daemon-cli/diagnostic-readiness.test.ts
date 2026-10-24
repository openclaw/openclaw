import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import {
  callGateway,
  classifyPortListener,
  hasActiveStartupMigrationLease,
  inspectPortUsage,
  monotonicClock,
  readActiveGatewayLockIdentity,
  readGatewayOwnerLease,
  requestStartupProbe,
  resetRestartHealthMocks,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const { readRuntime, readCommand, isAbsent, isDefaultInstallIdentity } = vi.hoisted(() => ({
  readCommand: vi.fn<GatewayService["readCommand"]>(),
  readRuntime: vi.fn<GatewayService["readRuntime"]>(),
  isAbsent: vi.fn<NonNullable<GatewayService["isAbsent"]>>(),
  isDefaultInstallIdentity: vi.fn(() => true),
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  isDefaultInstallIdentity,
}));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readRuntime, readCommand, isAbsent }),
}));
const { waitForGatewayDiagnosticReadiness } = await import("./diagnostic-readiness.js");
const noAuthConfig: OpenClawConfig = { gateway: { auth: { mode: "none" } } };
const nativeCommand = { programArguments: ["gateway", "--port", "18789"] };

function waitForReadiness(options: Parameters<typeof waitForGatewayDiagnosticReadiness>[0] = {}) {
  return waitForGatewayDiagnosticReadiness({ config: noAuthConfig, timeoutMs: 1_250, ...options });
}

function portUsage(
  port: number,
  listeners: Array<{ pid: number; ppid?: number; command?: string }> = [],
) {
  return {
    port,
    status: listeners.length ? ("busy" as const) : ("free" as const),
    listeners,
    hints: [],
  };
}

function startedGateway() {
  requestStartupProbe.mockResolvedValue({ statusCode: 200, body: '{"status":"started"}' });
  callGateway.mockImplementation(gatewayHealthResponse());
}

function missingService(platformAbsent = true) {
  isAbsent.mockResolvedValue(platformAbsent);
  readCommand.mockResolvedValue(null);
  readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
}

function expectWait(
  result: Awaited<ReturnType<typeof waitForReadiness>>,
  waitOutcome: string,
  elapsedMs: number,
) {
  expect(result).toMatchObject({ waitOutcome, elapsedMs });
  expect(monotonicClock.nowMs).toBe(elapsedMs);
}

function legacyOwner(pid = 8000, port = 18789) {
  return { pid, port, createdAt: "2026-09-01T00:00:00.000Z" };
}

function advanceClock<T>(ms: number, value: T) {
  monotonicClock.nowMs += ms;
  return value;
}

function foregroundOwner(owner = "fixture-owner", port = 18789) {
  return {
    owner,
    pid: 8000,
    host: "fixture-host",
    startedAt: 1,
    port,
    mode: "foreground" as const,
    supervisor: null,
    state: "live" as const,
    expired: false,
  };
}

const missingServiceCases = [
  ["managerless", true, "native", 1_000, 1_250],
  ["native missing unit", false, "native", 20_000, 30_000],
  ["external supervisor", false, "external", 1_000, 1_250],
] as const;

beforeEach(() => {
  resetRestartHealthMocks();
  inspectPortUsage.mockImplementation(async (port) => portUsage(port));
  readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
  readCommand.mockReset().mockResolvedValue(nativeCommand);
  isAbsent.mockReset().mockResolvedValue(false);
  isDefaultInstallIdentity.mockReset().mockReturnValue(true);
  vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
});
afterEach(() => {
  restoreRestartHealthMocks();
  vi.unstubAllEnvs();
});

it.each<{ envUrl?: string; url?: string; config?: OpenClawConfig }>([
  { url: "ws://127.0.0.1:18789" },
  { config: { gateway: { mode: "remote", remote: { url: "wss://peer.example" } } } },
  { envUrl: "wss://peer.example" },
  { config: { gateway: { auth: { mode: "token" } } } },
])("defers explicit, remote, or unauthenticated targets: %j", async ({ envUrl, ...options }) => {
  if (envUrl) {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", envUrl);
  }
  await expect(
    waitForGatewayDiagnosticReadiness({ config: {}, ...options }),
  ).resolves.toBeUndefined();
  expect(monotonicClock.nowMs).toBe(0);
  expectNoCalls(readRuntime, inspectPortUsage, callGateway);
});

it.each([22_000, 61_000])(
  "charges %d ms of authentication preparation to the caller's absolute deadline",
  async (authElapsedMs) => {
    resolveGatewayProbeAuthSafeWithSecretInputs.mockImplementation(async () =>
      advanceClock(authElapsedMs, { auth: { token: "fixture-token" } }),
    );
    readGatewayOwnerLease.mockReturnValue(foregroundOwner());
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "token" } } },
      timeoutMs: 60_000,
      deadlineMs: 60_000,
    });
    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: authElapsedMs < 60_000 ? "still-starting" : "timeout",
      elapsedMs: Math.max(0, 60_000 - authElapsedMs),
    });
    expect(monotonicClock.nowMs).toBe(Math.max(60_000, authElapsedMs));
    expect(callGateway).not.toHaveBeenCalled();
    if (authElapsedMs >= 60_000) {
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(result?.probeError).toBe("Gateway readiness budget exhausted.");
    }
  },
);

it.each(
  (
    [
      [20_000, 19_500, false],
      [7_500, 20_000, false],
      [20_000, 19_500, true],
      [7_500, 20_000, true],
      [20_000, 20_000, false],
    ] as const
  ).flatMap(([timeoutMs, readyAtMs, ownerAppearsDuringProbe]) =>
    ["lease", "legacy lock"].map(
      (ownerKind) => [timeoutMs, readyAtMs, ownerAppearsDuringProbe, ownerKind] as const,
    ),
  ),
)(
  "observes startup within %d ms, ready at %d ms (late owner=%s, kind=%s)",
  async (timeoutMs, readyAtMs, ownerAppearsDuringProbe, ownerKind) => {
    isAbsent.mockResolvedValue(true);
    const config: OpenClawConfig = { gateway: { port: 19091, auth: { mode: "token" } } };
    resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({
      auth: { token: "fixture-token" },
    });
    const owner = foregroundOwner("fixture-owner", 19091);
    const publishOwner = () => {
      if (ownerKind === "lease") {
        readGatewayOwnerLease.mockReturnValue(owner);
      } else {
        readActiveGatewayLockIdentity.mockResolvedValue(legacyOwner(owner.pid, owner.port));
      }
    };
    if (ownerAppearsDuringProbe) {
      readCommand.mockResolvedValue(null);
      inspectPortUsage.mockImplementationOnce(async (port) => {
        publishOwner();
        return portUsage(port);
      });
    } else {
      publishOwner();
    }
    inspectPortUsage.mockImplementation(async (port) => {
      const listening = ownerKind !== "legacy lock" || monotonicClock.nowMs >= 1_000;
      return portUsage(port, listening ? [{ pid: 8000 }] : []);
    });
    requestStartupProbe.mockImplementation(async () => ({
      statusCode: monotonicClock.nowMs < readyAtMs ? 503 : 200,
      body: JSON.stringify(
        monotonicClock.nowMs < readyAtMs
          ? { status: "starting", pendingReason: "plugin-convergence" }
          : { status: "started" },
      ),
    }));
    callGateway.mockImplementation(gatewayHealthResponse());
    const result = await waitForGatewayDiagnosticReadiness({
      config,
      token: "fixture-token",
      timeoutMs,
    });
    expect(result).toMatchObject({
      healthy: readyAtMs < timeoutMs,
      waitOutcome: readyAtMs < timeoutMs ? "healthy" : "still-starting",
      elapsedMs: Math.min(timeoutMs, readyAtMs),
      runtime: { status: "running", pid: 8000 },
      portUsage: { port: 19091 },
    });
    expect(readRuntime).not.toHaveBeenCalled();
    if (readyAtMs < timeoutMs) {
      expectPartialCall(callGateway, {
        config,
        token: "fixture-token",
        localPortOverride: 19091,
      });
    } else {
      expect(result?.startupPhase).toBe("plugin-convergence");
      expect(callGateway).not.toHaveBeenCalled();
    }
  },
);

it("waits for a legacy replacement after an observed owner lease dies", async () => {
  let leasePublished = false;
  isAbsent.mockResolvedValue(true);
  readCommand.mockResolvedValue(null);
  readGatewayOwnerLease.mockImplementation(() =>
    leasePublished
      ? {
          ...foregroundOwner("previous-owner"),
          state: monotonicClock.nowMs === 0 ? "live" : "dead",
        }
      : undefined,
  );
  inspectPortUsage.mockImplementation(async (port) => {
    if (monotonicClock.nowMs === 0) {
      leasePublished = true;
    } else {
      readActiveGatewayLockIdentity.mockResolvedValue(legacyOwner(9000, port));
    }
    const listening = monotonicClock.nowMs >= 1_000;
    return portUsage(port, listening ? [{ pid: 9000 }] : []);
  });
  startedGateway();
  const result = await waitForReadiness({ timeoutMs: 5_000 });
  expect(result).toMatchObject({
    healthy: true,
    waitOutcome: "healthy",
    elapsedMs: 1_000,
    runtime: { status: "running", pid: 9000 },
  });
});

it.each([
  ...["service-command", "permissive command", "absence", "legacy lock", "late legacy lock"].map(
    (source) =>
      [source, source === "late legacy lock" ? 30_000 : 1_250, undefined, undefined] as const,
  ),
  ...missingServiceCases.map(
    ([name, platformAbsent, serviceMode, _readyAtMs, timeoutMs]) =>
      [`startup migration (${name})`, timeoutMs, platformAbsent, serviceMode] as const,
  ),
])(
  "retains startup grace when %s lookup fails",
  async (source, timeoutMs, platformAbsent, serviceMode) => {
    const error = new Error("owner lookup unavailable");
    if (platformAbsent !== undefined) {
      missingService(platformAbsent);
      hasActiveStartupMigrationLease.mockImplementation(() => {
        throw new Error("startup migration owner unavailable");
      });
    } else if (source === "service-command") {
      readCommand.mockRejectedValue(error);
    } else if (source === "permissive command") {
      readCommand.mockImplementation(async (_env, options) => {
        if (options?.requireEffective) {
          throw error;
        }
        return null;
      });
    } else if (source === "absence") {
      isAbsent.mockRejectedValue(error);
    } else {
      if (source !== "late legacy lock") {
        readCommand.mockResolvedValue(null);
      }
      readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
      readActiveGatewayLockIdentity.mockRejectedValue(error);
    }
    const result = await waitForReadiness({ serviceMode, timeoutMs });
    expectWait(result, "timeout", timeoutMs);
  },
);

it.each(["initial runtime", "late legacy owner"])(
  "preserves uncertain cleanup from %s inspection",
  async (phase) => {
    const error = new CommandProcessCleanupError();
    if (phase === "initial runtime") {
      readRuntime.mockRejectedValueOnce(error);
    } else {
      isAbsent.mockResolvedValue(true);
      readActiveGatewayLockIdentity.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    }
    await expect(waitForReadiness()).rejects.toBe(error);
  },
);

it.each(["missing command", "different port", "unavailable manager"])(
  "does not wait for an absent Gateway with %s",
  async (reason) => {
    const unavailableManager = reason === "unavailable manager";
    isAbsent.mockResolvedValue(reason !== "different port");
    if (unavailableManager) {
      readCommand.mockRejectedValue(new Error("service manager unavailable"));
    } else {
      readCommand.mockResolvedValue(reason === "missing command" ? null : nativeCommand);
      readRuntime.mockResolvedValueOnce({ status: "running" });
    }
    const result = await waitForGatewayDiagnosticReadiness({
      config: noAuthConfig,
      localPortOverride: unavailableManager ? undefined : 19092,
      timeoutMs: unavailableManager ? 1_250 : 60_000,
    });
    expect(result).toBeUndefined();
    expect(monotonicClock.nowMs).toBe(0);
    expect(readRuntime).not.toHaveBeenCalled();
    if (unavailableManager) {
      expect(readCommand).not.toHaveBeenCalled();
    }
  },
);

it.each(
  ["external", "isolated"].flatMap((context) =>
    ["absent", "starting"].map((state) => ({ context, state })),
  ),
)(
  "avoids unrelated native inspection for a $context $state Gateway",
  async ({ context, state }) => {
    isDefaultInstallIdentity.mockReturnValue(context !== "isolated");
    isAbsent.mockRejectedValue(new Error("service manager unavailable"));
    if (state === "starting") {
      readGatewayOwnerLease.mockReturnValue({
        ...foregroundOwner("external-owner"),
        mode: context === "isolated" ? "foreground" : "supervised",
        supervisor: context === "isolated" ? null : { kind: "systemd", name: "custom-gateway" },
      });
    }
    const result = await waitForReadiness({
      serviceMode: context === "external" ? "external" : undefined,
    });
    if (state === "starting") {
      expect(result).toMatchObject({
        waitOutcome: "still-starting",
        elapsedMs: 1_250,
        runtime: { status: "running", pid: 8000 },
      });
    } else {
      expect(result).toBeUndefined();
      expect(monotonicClock.nowMs).toBe(0);
    }
    expectNoCalls(isAbsent, readCommand, readRuntime);
  },
);

it.each(missingServiceCases)(
  "waits for startup migration to hand off to a foreground Gateway with %s",
  async (_name, platformAbsent, serviceMode, readyAtMs, timeoutMs) => {
    missingService(platformAbsent);
    hasActiveStartupMigrationLease.mockImplementation(() => monotonicClock.nowMs < readyAtMs - 500);
    readGatewayOwnerLease.mockImplementation(() =>
      monotonicClock.nowMs < readyAtMs ? undefined : foregroundOwner("migrated-owner"),
    );
    inspectPortUsage.mockImplementation(async (port) =>
      portUsage(port, monotonicClock.nowMs < readyAtMs ? [] : [{ pid: 8000 }]),
    );
    startedGateway();
    const result = await waitForReadiness({ serviceMode, timeoutMs });
    expectWait(result, "healthy", readyAtMs);
    expect(result?.healthy).toBe(true);
  },
);

it.each([
  { phase: "service inspection", ownerElapsedMs: 0, deadlineMs: 60_000 },
  { phase: "initial owner", ownerElapsedMs: 400 },
  { phase: "initial owner", ownerElapsedMs: 1_500 },
  { phase: "final owner", ownerElapsedMs: 1_500 },
  { phase: "initial lock", ownerElapsedMs: 0, deadlineMs: 60_000 },
  { phase: "late lock", ownerElapsedMs: 0, deadlineMs: 60_000 },
])(
  "charges $phase reads ($ownerElapsedMs ms owner lookup) to the remaining diagnostic budget",
  async ({ phase, ownerElapsedMs, deadlineMs }) => {
    if (phase === "service inspection") {
      isAbsent.mockImplementation(async () => advanceClock(400, false));
      readCommand.mockImplementation(async () => advanceClock(300, nativeCommand));
      readRuntime.mockImplementation(async (_env, options) =>
        advanceClock(options?.timeoutMs ?? 0, { status: "stopped" as const }),
      );
    } else if (phase === "initial owner") {
      readGatewayOwnerLease.mockImplementationOnce(() => advanceClock(ownerElapsedMs, undefined));
      isAbsent.mockImplementation(async (options) => advanceClock(options?.timeoutMs ?? 0, true));
    } else {
      isAbsent.mockResolvedValue(true);
      if (phase === "final owner") {
        readGatewayOwnerLease
          .mockReturnValueOnce(undefined)
          .mockImplementationOnce(() => advanceClock(ownerElapsedMs, undefined));
      } else {
        if (phase === "initial lock") {
          isAbsent.mockImplementation(async () => advanceClock(1_125, true));
        } else {
          readActiveGatewayLockIdentity.mockImplementationOnce(async () =>
            advanceClock(1_125, undefined),
          );
        }
        readActiveGatewayLockIdentity.mockImplementationOnce(
          async (options?: { timeoutMs?: number }) =>
            advanceClock(options?.timeoutMs ?? 1_000, undefined),
        );
      }
    }
    expectWait(await waitForReadiness({ deadlineMs }), "timeout", Math.max(1_250, ownerElapsedMs));
    if (phase === "initial owner") {
      expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
      if (ownerElapsedMs >= 1_250) {
        expect(isAbsent).not.toHaveBeenCalled();
      }
    }
  },
);

it.each(["initial", "late"])(
  "bounds the %s legacy lookup through the numeric diagnostic budget",
  async (phase) => {
    isAbsent.mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = createDeferred();
    const released = createDeferred();
    let nativeInspections = 0;
    if (phase === "late") {
      readActiveGatewayLockIdentity.mockResolvedValueOnce(undefined);
    }
    readActiveGatewayLockIdentity.mockImplementationOnce(
      async (options?: { signal?: AbortSignal }) => {
        entered.resolve();
        await released.promise;
        options?.signal?.throwIfAborted();
        nativeInspections += 1;
        return undefined;
      },
    );
    const settled = vi.fn();
    const observed = waitForReadiness({ deadlineMs: 60_000 }).then(
      (value) => settled({ value }),
      (error: unknown) => settled({ error }),
    );
    const reads = () => [
      readRuntime.mock.calls.length,
      inspectPortUsage.mock.calls.length,
      readGatewayOwnerLease.mock.calls.length,
      nativeInspections,
    ];
    try {
      await entered.promise;
      monotonicClock.nowMs = 1_250;
      await vi.advanceTimersByTimeAsync(1_250);
      expectPartialCall(settled, {
        value: expect.objectContaining({ waitOutcome: "timeout", elapsedMs: 1_250 }),
      });
      const atExpiry = reads();
      released.resolve();
      await observed;
      await vi.advanceTimersByTimeAsync(0);
      expect(reads()).toEqual(atExpiry);
    } finally {
      released.resolve();
      await observed;
      vi.useRealTimers();
    }
  },
);

it.each(["loaded", "unverifiable", "absent", "stopped", "unknown"] as const)(
  "honors the native runtime's %s verdict within the caller's deadline",
  async (owner) => {
    if (owner === "stopped" || owner === "unknown") {
      readRuntime.mockResolvedValue({ status: owner });
    } else {
      readCommand.mockResolvedValue(null);
      readRuntime.mockResolvedValue(
        owner === "absent"
          ? { status: "stopped", missingUnit: true }
          : {
              status: "unknown",
              systemLaunchDaemon: { status: owner, serviceTarget: "system/ai.openclaw.gateway" },
            },
      );
    }
    const result = await waitForReadiness();
    if (owner === "absent") {
      expect(result).toBeUndefined();
      expect(monotonicClock.nowMs).toBe(0);
    } else {
      expect(result).toMatchObject({ waitOutcome: "timeout", elapsedMs: 1_250 });
      if (owner === "stopped" || owner === "unknown") {
        expect(result).toMatchObject({ healthy: false, portUsage: { status: "free" } });
        expect(callGateway).not.toHaveBeenCalled();
      }
    }
  },
);

it("still probes an unowned listener without an installed service", async () => {
  readCommand.mockResolvedValue(null);
  inspectPortUsage.mockResolvedValue(portUsage(18789, [{ pid: 8000 }]));
  callGateway.mockImplementation(gatewayHealthResponse());
  const result = await waitForGatewayDiagnosticReadiness({ config: noAuthConfig });
  expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy" });
  expect(monotonicClock.nowMs).toBe(0);
});

it.each(["missing", "stopped"])(
  "reports a verified foreign port for a %s service without consuming the budget",
  async (runtime) => {
    if (runtime === "missing") {
      readCommand.mockResolvedValue(null);
    }
    classifyPortListener.mockReturnValue("non_gateway");
    inspectPortUsage.mockResolvedValue(portUsage(18789, [{ pid: 4242, command: "socat" }]));
    const result = await waitForReadiness();
    expect(result).toMatchObject({ healthy: false, waitOutcome: "port-held", elapsedMs: 0 });
    expect(result?.probeError).toContain("port 18789 is held by another process");
    expect(result?.probeError).toContain("openclaw gateway status --deep");
    if (!result) {
      throw new Error("Expected the port-conflict diagnostic");
    }
    const { formatGatewayRestartFailure } = await import("./restart-health-diagnostics.js");
    const failure = formatGatewayRestartFailure({
      health: result,
      port: 18789,
      defaultTimeoutSeconds: 60,
    });
    expect(failure.failMessage).toContain("held by another process");
    expect(failure.statusLine).not.toContain("Timed out");
  },
);

function nativePid(pid: number) {
  readCommand.mockResolvedValue(nativeCommand);
  readRuntime.mockResolvedValue({ status: "stopped", pid });
}

it.each(
  Object.entries({
    "unknown listener": () => classifyPortListener.mockReturnValue("unknown"),
    "empty attribution": () =>
      inspectPortUsage.mockResolvedValue({ ...portUsage(18789), status: "busy" }),
    "mixed listeners": () => {
      const foreign = { pid: 4242, ppid: 1, command: "socat" };
      inspectPortUsage.mockResolvedValue(
        portUsage(18789, [foreign, { pid: 4243, ppid: 1, command: "node" }]),
      );
      classifyPortListener.mockImplementation((listener) =>
        listener === foreign ? "non_gateway" : "unknown",
      );
    },
    "runtime PID": () => nativePid(4242),
    "runtime PPID": () => nativePid(1),
    "live owner": () => readGatewayOwnerLease.mockReturnValue(foregroundOwner()),
    "unknown owner": () =>
      readGatewayOwnerLease.mockReturnValue({ ...foregroundOwner(), state: "unknown" }),
    "legacy owner": () => readActiveGatewayLockIdentity.mockResolvedValue(legacyOwner()),
    "startup migration": () => hasActiveStartupMigrationLease.mockReturnValue(true),
    "migration inspection failure": () =>
      hasActiveStartupMigrationLease.mockImplementation(() => {
        throw new Error("unavailable");
      }),
  }),
)("preserves startup grace for %s on a busy port", async (_reason, setup) => {
  readCommand.mockResolvedValue(null);
  classifyPortListener.mockReturnValue("non_gateway");
  inspectPortUsage.mockResolvedValue(portUsage(18789, [{ pid: 4242, ppid: 1, command: "socat" }]));
  setup();
  await expect(waitForReadiness()).resolves.toMatchObject({
    healthy: false,
    waitOutcome: "timeout",
    elapsedMs: 1_250,
  });
});
