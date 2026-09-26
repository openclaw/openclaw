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

const missingServiceCases = [
  { name: "managerless", platformAbsent: true, readyAtMs: 1_000, timeoutMs: 1_250 },
  { name: "native missing unit", platformAbsent: false, readyAtMs: 20_000, timeoutMs: 30_000 },
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
  ])("preserves an explicit or remote target: %j", async ({ envUrl, ...options }) => {
    if (envUrl) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", envUrl);
    }
    await expect(
      waitForGatewayDiagnosticReadiness({ config: {}, ...options }),
    ).resolves.toBeUndefined();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("defers to original diagnostic authentication when no shared credential is available", async () => {
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "token" } } },
    });
    expect(result).toBeUndefined();
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
        waitOutcome: "timeout",
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
      const owner = {
        owner: "fixture-owner",
        pid: 8000,
        host: "fixture-host",
        startedAt: 1,
        port: 19091,
        mode: "foreground" as const,
        supervisor: null,
        state: "live" as const,
        expired: false,
      };
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

  it("caps service inspection by an explicit timeout before a later deadline", async () => {
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

    await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_250,
      deadlineMs: 60_000,
    });

    expect(monotonicClock.nowMs).toBe(1_250);
  });

  it("waits for a legacy replacement after an observed owner lease dies", async () => {
    let leasePublished = false;
    isAbsent.mockResolvedValue(true);
    readCommand.mockResolvedValue(null);
    readGatewayOwnerLease.mockImplementation(() =>
      leasePublished
        ? {
            owner: "previous-owner",
            pid: 8000,
            host: "fixture-host",
            startedAt: 1,
            port: 18789,
            mode: "foreground",
            supervisor: null,
            state: monotonicClock.nowMs === 0 ? "live" : "dead",
            expired: false,
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
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      elapsedMs: 1_000,
      runtime: { status: "running", pid: 9000 },
    });
  });

  it.each(["service-command", "permissive command", "absence", "legacy lock", "late legacy lock"])(
    "retains startup grace when %s lookup fails",
    async (source) => {
      const error = new Error("owner lookup unavailable");
      if (source === "service-command") {
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

      const timeoutMs = source === "late legacy lock" ? 30_000 : 1_250;
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
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
          config: { gateway: { auth: { mode: "none" } } },
          timeoutMs: 1_250,
        }),
      ).rejects.toBe(error);
    },
  );

  it.each([null, { programArguments: ["gateway", "--port", "18789"] }])(
    "does not wait for an absent Gateway without a matching installed service: %j",
    async (command) => {
      readCommand.mockResolvedValue(command);
      isAbsent.mockResolvedValue(command === null);
      readRuntime.mockResolvedValueOnce({ status: "running" });
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        localPortOverride: 19092,
        timeoutMs: 60_000,
      });
      expect(result).toBeUndefined();
      expect(monotonicClock.nowMs).toBe(0);
      expect(readRuntime).not.toHaveBeenCalled();
    },
  );

  it("uses platform-confirmed absence without requiring a service manager", async () => {
    isAbsent.mockResolvedValue(true);
    readCommand.mockRejectedValue(new Error("service manager unavailable"));

    await expect(
      waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      }),
    ).resolves.toBeUndefined();

    expect(monotonicClock.nowMs).toBe(0);
    expect(readCommand).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
  });

  it.each(missingServiceCases)(
    "waits for startup migration to hand off to a foreground Gateway with $name",
    async ({ platformAbsent, readyAtMs, timeoutMs }) => {
      isAbsent.mockResolvedValue(platformAbsent);
      readCommand.mockResolvedValue(null);
      readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
      hasActiveStartupMigrationLease.mockImplementation(
        () => monotonicClock.nowMs < readyAtMs - 500,
      );
      readGatewayOwnerLease.mockImplementation(() =>
        monotonicClock.nowMs < readyAtMs
          ? undefined
          : {
              owner: "migrated-owner",
              pid: 8000,
              host: "fixture-host",
              startedAt: 1,
              port: 18789,
              mode: "foreground",
              supervisor: null,
              state: "live",
              expired: false,
            },
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
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs,
      });
      expect(monotonicClock.nowMs).toBe(readyAtMs);
      expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: readyAtMs });
    },
  );

  it.each(missingServiceCases)(
    "retains grace when startup migration ownership cannot be inspected with $name",
    async ({ platformAbsent, timeoutMs }) => {
      isAbsent.mockResolvedValue(platformAbsent);
      readCommand.mockResolvedValue(null);
      readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
      hasActiveStartupMigrationLease.mockImplementation(() => {
        throw new Error("startup migration owner unavailable");
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs,
      });
      expect(monotonicClock.nowMs).toBe(timeoutMs);
      expect(result).toMatchObject({ waitOutcome: "timeout", elapsedMs: timeoutMs });
    },
  );

  it.each([400, 1_500])(
    "charges a %d ms initial owner read before service discovery",
    async (ownerElapsedMs) => {
      readGatewayOwnerLease.mockImplementationOnce(() => {
        monotonicClock.nowMs += ownerElapsedMs;
        return undefined;
      });
      isAbsent.mockImplementation(async (options) => {
        monotonicClock.nowMs += options?.timeoutMs ?? 0;
        return true;
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      });

      expect(result).toMatchObject({
        waitOutcome: "timeout",
        elapsedMs: Math.max(1_250, ownerElapsedMs),
      });
      expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
      if (ownerElapsedMs >= 1_250) {
        expect(isAbsent).not.toHaveBeenCalled();
      }
    },
  );

  it("reports timeout after the final owner read consumes the remaining allowance", async () => {
    isAbsent.mockResolvedValue(true);
    readGatewayOwnerLease.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
      monotonicClock.nowMs += 1_500;
      return undefined;
    });

    await expect(
      waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      }),
    ).resolves.toMatchObject({ waitOutcome: "timeout", elapsedMs: 1_500 });
  });

  it.each(["initial", "late"])(
    "passes the remaining allowance to the %s native lock inspection",
    async (phase) => {
      isAbsent.mockResolvedValue(true);
      if (phase === "initial") {
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

      await expect(
        waitForGatewayDiagnosticReadiness({
          config: { gateway: { auth: { mode: "none" } } },
          timeoutMs: 1_250,
          deadlineMs: 60_000,
        }),
      ).resolves.toMatchObject({ waitOutcome: "timeout", elapsedMs: 1_250 });
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
        config: { gateway: { auth: { mode: "none" } } },
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

  it.each(["loaded", "unverifiable", "absent"] as const)(
    "uses the native runtime's %s owner verdict after a strict command read finds no command",
    async (owner) => {
      readCommand.mockResolvedValue(null);
      readRuntime.mockResolvedValue(
        owner === "absent"
          ? { status: "stopped", missingUnit: true }
          : {
              status: "unknown",
              systemLaunchDaemon: { status: owner, serviceTarget: "system/ai.openclaw.gateway" },
            },
      );

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      });

      if (owner === "absent") {
        expect(result).toBeUndefined();
        expect(monotonicClock.nowMs).toBe(0);
      } else {
        expect(result).toMatchObject({ waitOutcome: "timeout", elapsedMs: 1_250 });
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
      config: { gateway: { auth: { mode: "none" } } },
    });

    expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy" });
    expect(monotonicClock.nowMs).toBe(0);
  });

  it.each(["stopped", "unknown"])(
    "bounds a %s installed Gateway with the caller's shorter deadline",
    async (status) => {
      readRuntime.mockResolvedValue({ status });
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      });
      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 1_250,
        portUsage: { status: "free" },
      });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );
});
