import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import {
  acquireGatewayLock,
  GatewayLockError,
  type GatewayLockOptions,
} from "../../infra/gateway-lock.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { getFreePort } from "../../test-utils/ports.js";
import type { GatewayLoopParams } from "./run-cleanup-receipt.test-support.js";

export function registerGatewayLockFailureTests({
  expectExit,
  configState,
  withoutSupervisorEnv,
  startGatewayServer,
  writeDiagnosticStabilityBundleForFailureSync,
  runGatewayLoop,
  detectRespawnSupervisor,
  runtimeErrors,
  triageAfterFailure,
}: {
  expectExit: (code: number) => Promise<void>;
  configState: { snapshot: Record<string, unknown> };
  withoutSupervisorEnv: Record<string, string | undefined>;
  startGatewayServer: Mock<(port: number, opts?: unknown) => Promise<unknown>>;
  writeDiagnosticStabilityBundleForFailureSync: Mock;
  runGatewayLoop: Mock<(params: GatewayLoopParams) => Promise<void>>;
  detectRespawnSupervisor: Mock<() => "systemd" | null>;
  runtimeErrors: string[];
  triageAfterFailure: Mock<() => Promise<undefined>>;
}) {
  it("skips failure bundles but exits nonzero for unconfirmed gateway lock conflicts", async () => {
    const port = await getFreePort();
    configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`gateway already running on port ${port}`), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    await withEnvAsync(withoutSupervisorEnv, async () => {
      await expectExit(1);
    });

    expect(writeDiagnosticStabilityBundleForFailureSync).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledWith(port, expect.any(Object));
    expect(runtimeErrors.join("\n")).toContain(`gateway already running on port ${port}`);
    expect(runtimeErrors.join("\n")).toContain("gateway stop");
    expect(triageAfterFailure).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "hardens a real user-owned read-only state database before acquiring it",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-readonly-"));
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const options: GatewayLockOptions = {
        env: { OPENCLAW_STATE_DIR: root },
        allowInTests: true,
        listenerMode: "supervised",
        supervisor: { kind: "systemd", name: null },
        port: 12345,
        timeoutMs: 0,
      };
      try {
        const initial = await acquireGatewayLock(options);
        await initial?.release();
        await fs.chmod(databasePath, 0o444);
        const lock = await acquireGatewayLock(options);
        try {
          expect(lock).not.toBeNull();
          expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600);
        } finally {
          await lock?.release();
        }
      } finally {
        await fs.chmod(databasePath, 0o600);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "reports a real immutable state database without contention diagnostics or retry",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-immutable-"));
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const lockOptions: GatewayLockOptions = {
        env: { OPENCLAW_STATE_DIR: root },
        allowInTests: true,
        listenerMode: "supervised",
        supervisor: { kind: "systemd", name: null },
        port: 12345,
        timeoutMs: 0,
      };
      const initial = await acquireGatewayLock(lockOptions);
      await initial?.release();
      await fs.chmod(databasePath, 0o444);
      try {
        execFileSync("/usr/bin/chflags", ["uchg", databasePath]);
        const { inspectPortUsage } = await import("../../infra/ports-inspect.js");
        detectRespawnSupervisor.mockReturnValue("systemd");
        runGatewayLoop.mockImplementationOnce(async () => {
          await acquireGatewayLock(lockOptions);
        });
        await expectExit(1);
        const output = runtimeErrors.join("\n");
        expect(output).toContain("storage failure");
        expect(output).toContain(databasePath);
        expect(output).toContain("read-only or not writable by this user");
        expect(output).toContain("chflags nouchg");
        expect(output).toContain("openclaw doctor");
        expect(output).not.toContain("gateway stop");
        expect(inspectPortUsage).not.toHaveBeenCalled();
        expect(runGatewayLoop).toHaveBeenCalledOnce();
        expect(triageAfterFailure).not.toHaveBeenCalled();
        expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o444);
      } finally {
        execFileSync("/usr/bin/chflags", ["nouchg", databasePath]);
        await fs.chmod(databasePath, 0o600);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["SQLITE_FULL", "Free up space"],
    ["SQLITE_IOERR_READ", "check the volume for I/O errors"],
    ["SQLITE_CANTOPEN", "check the volume for I/O errors"],
  ])("reports %s without suggesting another Gateway", async (code, remedy) => {
    runGatewayLoop.mockRejectedValueOnce(
      new GatewayLockError(
        "failed to acquire gateway state ownership",
        Object.assign(new Error("storage unavailable"), { code }),
        "/synthetic/state/openclaw.sqlite",
      ),
    );
    await expectExit(1);
    expect(runtimeErrors.join("\n")).toContain(remedy);
    expect(runtimeErrors.join("\n")).toContain("openclaw doctor");
    expect(runtimeErrors.join("\n")).not.toContain("gateway stop");
  });

  it.each(
    ["EACCES", "EPERM", "EROFS", "EIO", "ENOSPC"].flatMap((code) =>
      [true, false].map((hasDatabasePath) => ({ code, hasDatabasePath })),
    ),
  )(
    "requires database context for $code (hasDatabasePath=$hasDatabasePath)",
    async ({ code, hasDatabasePath }) => {
      const databasePath = "/synthetic/state/openclaw.sqlite";
      runGatewayLoop.mockRejectedValueOnce(
        new GatewayLockError(
          "failed to acquire gateway state ownership",
          Object.assign(new Error("operation failed"), { code }),
          hasDatabasePath ? databasePath : undefined,
        ),
      );
      await expectExit(1);
      const output = runtimeErrors.join("\n");
      if (hasDatabasePath) {
        expect(output).toContain("storage failure");
        expect(output).toContain(databasePath);
        expect(output).toContain("openclaw doctor");
        expect(output).not.toContain("gateway stop");
      } else {
        expect(output).not.toContain("storage failure");
      }
    },
  );
}
