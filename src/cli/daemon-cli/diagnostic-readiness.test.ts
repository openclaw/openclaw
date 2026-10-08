import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  callGateway,
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

const { readRuntime, readCommand, isAbsent } = vi.hoisted(() => ({
  readCommand: vi.fn<GatewayService["readCommand"]>(),
  readRuntime: vi.fn<GatewayService["readRuntime"]>(),
  isAbsent: vi.fn<NonNullable<GatewayService["isAbsent"]>>(),
}));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readRuntime, readCommand, isAbsent }),
}));
const { waitForGatewayDiagnosticReadiness } = await import("./diagnostic-readiness.js");
const noAuthConfig: OpenClawConfig = { gateway: { auth: { mode: "none" } } };

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
  {
    name: "managerless",
    platformAbsent: true,
    serviceMode: "native",
    readyAtMs: 1_000,
    timeoutMs: 1_250,
  },
  {
    name: "native missing unit",
    platformAbsent: false,
    serviceMode: "native",
    readyAtMs: 20_000,
    timeoutMs: 30_000,
  },
  {
    name: "external supervisor",
    platformAbsent: false,
    serviceMode: "external",
    readyAtMs: 1_000,
    timeoutMs: 1_250,
  },
] as const;

describe("diagnostic Gateway readiness", () => {
  beforeEach(() => {
    resetRestartHealthMocks();
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: "free",
      listeners: [],
      hints: [],
    }));
    readRuntime.mockReset();
    readRuntime.mockResolvedValue({ status: "stopped" });
    readCommand.mockReset();
    readCommand.mockResolvedValue({ programArguments: ["gateway", "--port", "18789"] });
    isAbsent.mockReset().mockResolvedValue(false);
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
    expect(readRuntime).not.toHaveBeenCalled();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([22_000, 61_000])(
    "charges %d ms of authentication preparation to the caller's absolute deadline",
    async (authElapsedMs) => {
      resolveGatewayProbeAuthSafeWithSecretInputs.mockImplementation(async () => {
        monotonicClock.nowMs += authElapsedMs;
        return { auth: { token: "fixture-token" } };
      });
      readGatewayOwnerLease.mockReturnValue({
        owner: "fixture-owner",
        pid: 8000,
        host: "fixture-host",
        startedAt: 1,
        port: 18789,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });

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
    [
      { timeoutMs: 20_000, readyAtMs: 19_500, ownerAppearsDuringProbe: false },
      { timeoutMs: 7_500, readyAtMs: 20_000, ownerAppearsDuringProbe: false },
      { timeoutMs: 20_000, readyAtMs: 19_500, ownerAppearsDuringProbe: true },
      { timeoutMs: 7_500, readyAtMs: 20_000, ownerAppearsDuringProbe: true },
      { timeoutMs: 20_000, readyAtMs: 20_000, ownerAppearsDuringProbe: false },
    ].flatMap(({ timeoutMs, readyAtMs, ownerAppearsDuringProbe }) =>
      ["lease", "legacy lock"].map((ownerKind) => ({
        timeoutMs,
        readyAtMs,
        ownerAppearsDuringProbe,
        ownerKind,
      })),
    ),
  )(
    "observes $ownerKind startup at $readyAtMs ms within $timeoutMs ms (owner appears during probe: $ownerAppearsDuringProbe)",
    async ({ timeoutMs, readyAtMs, ownerAppearsDuringProbe, ownerKind }) => {
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
          readActiveGatewayLockIdentity.mockResolvedValue({
            pid: owner.pid,
            port: owner.port,
            createdAt: "2026-09-01T00:00:00.000Z",
          });
        }
      };
      if (ownerAppearsDuringProbe) {
        readCommand.mockResolvedValue(null);
        inspectPortUsage.mockImplementationOnce(async (port) => {
          publishOwner();
          return { port, status: "free", listeners: [], hints: [] };
        });
      } else {
        publishOwner();
      }
      inspectPortUsage.mockImplementation(async (port) => {
        const listening = ownerKind !== "legacy lock" || monotonicClock.nowMs >= 1_000;
        return {
          port,
          status: listening ? "busy" : "free",
          listeners: listening ? [{ pid: 8000 }] : [],
          hints: [],
        };
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
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({ config, token: "fixture-token", localPortOverride: 19091 }),
        );
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
        readActiveGatewayLockIdentity.mockResolvedValue({
          pid: 9000,
          port,
          createdAt: "2026-09-01T00:00:00.000Z",
        });
      }
      const listening = monotonicClock.nowMs >= 1_000;
      return {
        port,
        status: listening ? "busy" : "free",
        listeners: listening ? [{ pid: 9000 }] : [],
        hints: [],
      };
    });
    requestStartupProbe.mockResolvedValue({ statusCode: 200, body: '{"status":"started"}' });
    callGateway.mockImplementation(gatewayHealthResponse());

    const result = await waitForGatewayDiagnosticReadiness({
      config: noAuthConfig,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      elapsedMs: 1_000,
      runtime: { status: "running", pid: 9000 },
    });
  });

  it.each<{
    source: string;
    timeoutMs: number;
    platformAbsent?: boolean;
    serviceMode?: "native" | "external";
  }>([
    ...["service-command", "permissive command", "absence", "legacy lock", "late legacy lock"].map(
      (source) => ({ source, timeoutMs: source === "late legacy lock" ? 30_000 : 1_250 }),
    ),
    ...missingServiceCases.map(({ name, ...options }) => ({
      source: `startup migration (${name})`,
      ...options,
    })),
  ])(
    "retains startup grace when $source lookup fails",
    async ({ source, timeoutMs, platformAbsent, serviceMode }) => {
      const error = new Error("owner lookup unavailable");
      if (platformAbsent !== undefined) {
        isAbsent.mockResolvedValue(platformAbsent);
        readCommand.mockResolvedValue(null);
        readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
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
      } else if (source === "late legacy lock") {
        readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
        readActiveGatewayLockIdentity.mockRejectedValue(error);
      } else {
        readCommand.mockResolvedValue(null);
        readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
        readActiveGatewayLockIdentity.mockRejectedValue(error);
      }

      const result = await waitForGatewayDiagnosticReadiness({
        config: noAuthConfig,
        serviceMode,
        timeoutMs,
      });

      expect(monotonicClock.nowMs).toBe(timeoutMs);
      expect(result).toMatchObject({ waitOutcome: "timeout", elapsedMs: timeoutMs });
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

      await expect(
        waitForGatewayDiagnosticReadiness({
          config: noAuthConfig,
          timeoutMs: 1_250,
        }),
      ).rejects.toBe(error);
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
        readCommand.mockResolvedValue(
          reason === "missing command"
            ? null
            : { programArguments: ["gateway", "--port", "18789"] },
        );
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

  it.each(["absent", "starting"])(
    "avoids native manager inspection for an externally managed %s Gateway",
    async (state) => {
      isAbsent.mockRejectedValue(new Error("service manager unavailable"));
      if (state === "starting") {
        readGatewayOwnerLease.mockReturnValue({
          owner: "external-owner",
          pid: 8000,
          host: "fixture-host",
          startedAt: 1,
          port: 18789,
          mode: "supervised",
          supervisor: { kind: "systemd", name: "custom-gateway" },
          state: "live",
          expired: false,
        });
      }

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        serviceMode: "external",
        timeoutMs: 1_250,
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
      expect(isAbsent).not.toHaveBeenCalled();
      expect(readCommand).not.toHaveBeenCalled();
      expect(readRuntime).not.toHaveBeenCalled();
    },
  );

  it.each(missingServiceCases)(
    "waits for startup migration to hand off to a foreground Gateway with $name",
    async ({ platformAbsent, serviceMode, readyAtMs, timeoutMs }) => {
      isAbsent.mockResolvedValue(platformAbsent);
      readCommand.mockResolvedValue(null);
      readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
      hasActiveStartupMigrationLease.mockImplementation(
        () => monotonicClock.nowMs < readyAtMs - 500,
      );
      readGatewayOwnerLease.mockImplementation(() =>
        monotonicClock.nowMs < readyAtMs ? undefined : foregroundOwner("migrated-owner"),
      );
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: monotonicClock.nowMs < readyAtMs ? "free" : "busy",
        listeners: monotonicClock.nowMs < readyAtMs ? [] : [{ pid: 8000 }],
        hints: [],
      }));
      requestStartupProbe.mockResolvedValue({ statusCode: 200, body: '{"status":"started"}' });
      callGateway.mockImplementation(gatewayHealthResponse());

      const result = await waitForGatewayDiagnosticReadiness({
        config: noAuthConfig,
        serviceMode,
        timeoutMs,
      });
      expect(monotonicClock.nowMs).toBe(readyAtMs);
      expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: readyAtMs });
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
        isAbsent.mockImplementation(async () => {
          monotonicClock.nowMs += 400;
          return false;
        });
        readCommand.mockImplementation(async () => {
          monotonicClock.nowMs += 300;
          return { programArguments: ["gateway", "--port", "18789"] };
        });
        readRuntime.mockImplementation(async (_env, options) => {
          monotonicClock.nowMs += options?.timeoutMs ?? 0;
          return { status: "stopped" };
        });
      } else if (phase === "initial owner") {
        readGatewayOwnerLease.mockImplementationOnce(() => {
          monotonicClock.nowMs += ownerElapsedMs;
          return undefined;
        });
        isAbsent.mockImplementation(async (options) => {
          monotonicClock.nowMs += options?.timeoutMs ?? 0;
          return true;
        });
      } else {
        isAbsent.mockResolvedValue(true);
        if (phase === "final owner") {
          readGatewayOwnerLease.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
            monotonicClock.nowMs += ownerElapsedMs;
            return undefined;
          });
        } else {
          if (phase === "initial lock") {
            isAbsent.mockImplementation(async () => {
              monotonicClock.nowMs += 1_125;
              return true;
            });
          } else {
            readActiveGatewayLockIdentity.mockImplementationOnce(async () => {
              monotonicClock.nowMs += 1_125;
              return undefined;
            });
          }
          readActiveGatewayLockIdentity.mockImplementationOnce(
            async (options?: { timeoutMs?: number }) => {
              monotonicClock.nowMs += options?.timeoutMs ?? 1_000;
              return undefined;
            },
          );
        }
      }
      await expect(
        waitForGatewayDiagnosticReadiness({
          config: noAuthConfig,
          timeoutMs: 1_250,
          deadlineMs,
        }),
      ).resolves.toMatchObject({
        waitOutcome: "timeout",
        elapsedMs: Math.max(1_250, ownerElapsedMs),
      });
      expect(monotonicClock.nowMs).toBe(Math.max(1_250, ownerElapsedMs));
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
      let outcome:
        | { value?: Awaited<ReturnType<typeof waitForGatewayDiagnosticReadiness>>; error?: unknown }
        | undefined;
      const observed = waitForGatewayDiagnosticReadiness({
        config: noAuthConfig,
        timeoutMs: 1_250,
        deadlineMs: 60_000,
      }).then(
        (value) => {
          outcome = { value };
        },
        (error: unknown) => {
          outcome = { error };
        },
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
        expect(outcome).toMatchObject({ value: { waitOutcome: "timeout", elapsedMs: 1_250 } });
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

      const result = await waitForGatewayDiagnosticReadiness({
        config: noAuthConfig,
        timeoutMs: 1_250,
      });

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
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000 }],
      hints: [],
    });
    callGateway.mockImplementation(gatewayHealthResponse());

    const result = await waitForGatewayDiagnosticReadiness({
      config: noAuthConfig,
    });

    expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy" });
    expect(monotonicClock.nowMs).toBe(0);
  });
});
