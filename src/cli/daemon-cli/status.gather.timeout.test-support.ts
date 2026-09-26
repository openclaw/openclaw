import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import { callGatewayStatusProbe } from "./status.gather.probes.test-support.js";

export function registerStatusTimeoutTests(params: {
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
  serviceIsLoaded: Mock<
    (opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<boolean>
  >;
  serviceReadRuntime: Mock<
    (env?: NodeJS.ProcessEnv, opts?: { timeoutMs?: number }) => Promise<GatewayServiceRuntime>
  >;
  serviceReadCommand: { mock: { calls: unknown[][] } };
  auditGatewayServiceConfig: Mock<(opts?: unknown) => Promise<ServiceConfigAudit>>;
  makeTempDir: () => string;
}): void {
  const {
    gatherStatus,
    serviceIsLoaded,
    serviceReadRuntime,
    serviceReadCommand,
    auditGatewayServiceConfig,
  } = params;

  it.each([undefined, "10000", "20000"])(
    "keeps the Windows native budget independent of RPC for timeout %s",
    async (timeout) =>
      withMockedPlatform("win32", async () => {
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        onTestFinished(() => clock.mockRestore());
        const stateDir = params.makeTempDir();
        const nativeSpawn = vi
          .mocked(spawnSync)
          .mockClear()
          .mockImplementation((_file, _args, options) => {
            const expired = typeof options?.timeout === "number" && options.timeout < 12_000;
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: expired ? "" : JSON.stringify({ state: 4, lastRunResult: 0 }),
              stderr: "",
              status: expired ? null : 0,
              signal: null,
              ...(expired
                ? { error: Object.assign(new Error("cold probe timed out"), { code: "ETIMEDOUT" }) }
                : {}),
            };
          });
        serviceReadRuntime.mockImplementationOnce((env, options) =>
          readScheduledTaskRuntime(
            {
              ...env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_TASK_SCRIPT: path.join(stateDir, "missing.cmd"),
            },
            options,
          ),
        );
        try {
          const status = await gatherStatus({ rpc: { timeout } });
          expect(status.rpc?.ok).toBe(true);
          expect(callGatewayStatusProbe).toHaveBeenCalledWith(
            expect.objectContaining({
              timeoutMs: timeout === undefined ? 10_000 : Number(timeout),
            }),
          );
          expect(auditGatewayServiceConfig).toHaveBeenCalledWith(
            expect.objectContaining({
              timeoutMs: timeout === undefined ? 10_000 : Number(timeout),
            }),
          );
          if (timeout === "10000") {
            expect(status.service.runtime).toMatchObject({
              status: "unknown",
              inspectionFailure: {
                code: "service-runtime-inspection-failed",
                timeoutMs: 10_000,
                detail: "Scheduled Task probe timed out after 10000 ms (ETIMEDOUT).",
              },
            });
          } else {
            expect(status.service.runtime).toMatchObject({ status: "running", state: "Running" });
            expect(status.service.runtime?.inspectionFailure).toBeUndefined();
          }
          expect(nativeSpawn).toHaveBeenCalledExactlyOnceWith(
            expect.any(String),
            expect.any(Array),
            expect.objectContaining({ timeout: timeout === undefined ? 60_000 : Number(timeout) }),
          );
        } finally {
          nativeSpawn.mockRestore();
        }
      }),
  );

  it.each(["darwin", "linux"] as const)(
    "keeps the omitted native timeout at ten seconds on %s",
    async (platform) =>
      withMockedPlatform(platform, async () => {
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        onTestFinished(() => clock.mockRestore());
        await gatherStatus();
        expect(serviceReadRuntime).toHaveBeenCalledWith(expect.any(Object), { timeoutMs: 10_000 });
        expect(callGatewayStatusProbe).toHaveBeenCalledWith(
          expect.objectContaining({ timeoutMs: 10_000 }),
        );
      }),
  );

  it.each(["bogus", "0", "-1", "1.5"])(
    "rejects invalid status timeout %s before reading service state",
    async (timeout) => {
      await expect(gatherStatus({ rpc: { timeout } })).rejects.toThrow(
        `Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "${timeout}".`,
      );

      expect(serviceReadCommand).not.toHaveBeenCalled();
      expect(serviceIsLoaded).not.toHaveBeenCalled();
      expect(serviceReadRuntime).not.toHaveBeenCalled();
    },
  );
}
