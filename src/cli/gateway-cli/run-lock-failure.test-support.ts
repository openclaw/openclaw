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

async function withReadOnlyDatabase(
  run: (databasePath: string, options: GatewayLockOptions) => Promise<void>,
) {
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
    await run(databasePath, options);
  } finally {
    await fs.chmod(databasePath, 0o600);
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function registerGatewayLockFailureTests(f: {
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
    f.configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`gateway already running on port ${port}`), {
      name: "GatewayLockError",
    });
    f.startGatewayServer.mockRejectedValueOnce(err);

    await withEnvAsync(f.withoutSupervisorEnv, () => f.expectExit(1));

    expect(f.writeDiagnosticStabilityBundleForFailureSync).not.toHaveBeenCalled();
    expect(f.runtimeErrors.join("\n")).toContain(`gateway already running on port ${port}`);
    expect(f.runtimeErrors.join("\n")).toContain("gateway stop");
    expect(f.triageAfterFailure).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "hardens a real user-owned read-only state database before acquiring it",
    () =>
      withReadOnlyDatabase(async (databasePath, options) => {
        const lock = await acquireGatewayLock(options);
        try {
          expect(lock).not.toBeNull();
          expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o600);
        } finally {
          await lock?.release();
        }
      }),
  );

  it.skipIf(process.platform !== "darwin")(
    "reports a real immutable state database without contention diagnostics or retry",
    () =>
      withReadOnlyDatabase(async (databasePath, lockOptions) => {
        try {
          execFileSync("/usr/bin/chflags", ["uchg", databasePath]);
          const { inspectPortUsage } = await import("../../infra/ports-inspect.js");
          f.detectRespawnSupervisor.mockReturnValue("systemd");
          f.runGatewayLoop.mockImplementationOnce(async () => {
            await acquireGatewayLock(lockOptions);
          });
          await f.expectExit(1);
          const output = f.runtimeErrors.join("\n");
          expect(output).toContain("storage failure");
          expect(output).toContain(databasePath);
          expect(output).toContain("read-only or not writable by this user");
          expect(output).toContain("chflags nouchg");
          expect(output).toContain("openclaw doctor");
          expect(output).not.toContain("gateway stop");
          expect(inspectPortUsage).not.toHaveBeenCalled();
          expect(f.runGatewayLoop).toHaveBeenCalledOnce();
          expect(f.triageAfterFailure).not.toHaveBeenCalled();
          expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o444);
        } finally {
          execFileSync("/usr/bin/chflags", ["nouchg", databasePath]);
        }
      }),
  );

  it.each<[string, string | undefined]>([
    ["SQLITE_FULL", "Free up space"],
    ["SQLITE_IOERR_READ", "check the volume for I/O errors"],
    ["SQLITE_CANTOPEN", "check the volume for I/O errors"],
    ...["EACCES", "EPERM", "EROFS", "EIO", "ENOSPC"].map((code): [string, string | undefined] => [
      code,
      "storage failure",
    ]),
    ["EACCES", undefined],
  ])(
    "reports %s with database-specific guidance only in database context (%s)",
    async (code, remedy) => {
      const databasePath = "/synthetic/state/openclaw.sqlite";
      f.runGatewayLoop.mockRejectedValueOnce(
        new GatewayLockError(
          "failed to acquire gateway state ownership",
          Object.assign(new Error("operation failed"), { code }),
          remedy ? databasePath : undefined,
        ),
      );
      await f.expectExit(1);
      const output = f.runtimeErrors.join("\n");
      if (remedy) {
        expect(output).toContain(remedy);
        expect(output).toContain(databasePath);
        expect(output).toContain("openclaw doctor");
        expect(output).not.toContain("gateway stop");
      } else {
        expect(output).not.toContain("storage failure");
      }
    },
  );
}
