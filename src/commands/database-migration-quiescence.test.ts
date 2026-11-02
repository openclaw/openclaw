import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../gateway/call.js";
import type { GatewayMigrationQuiescenceScope } from "./database-migration-quiescence.js";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  discover: vi.fn(),
  paths: vi.fn(),
  readLock: vi.fn(),
  config: vi.fn(),
  auth: vi.fn(),
  alive: vi.fn(),
  start: vi.fn(),
}));
// mock-isolation: drive suspension replies and failures without contacting a real Gateway.
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.rpc }));
// mock-isolation: select synthetic shared auth without resolving operator credentials.
vi.mock("../gateway/auth-resolve.js", () => ({ resolveGatewayAuthForConfig: mocks.auth }));
// mock-isolation: supply local/remote config observations without loading operator state.
vi.mock("../config/io.js", () => ({
  createConfigIO: () => ({ readConfigFileSnapshot: mocks.config }),
}));
// mock-isolation: discover only the fixture owner and locks, never the host Gateway.
vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: mocks.discover,
  readLockPayloadSync: mocks.readLock,
  resolveGatewayLockPaths: mocks.paths,
}));
// mock-isolation: model recycled PID identity independently of the host process table.
vi.mock("../infra/gateway-lock-process.js", () => ({
  readGatewayLockProcessStartTime: mocks.start,
}));
// mock-isolation: the synthetic owner PID must not probe or depend on a host process.
vi.mock("../shared/pid-alive.js", () => ({ isPidAlive: mocks.alive }));

import { withGatewayMigrationQuiescence } from "./database-migration-quiescence.js";

let directory: string;
let ownerPath: string;
const owner = {
  ownerId: "source-owner",
  pid: 1234,
  startTime: 123,
  createdAt: "2026-10-29T00:00:00.000Z",
  port: 18789,
};
let outer: AbortController;
const requestId = "original-controller-request";
const suspensionId = "original-controller-suspension";

function status(extra = {}) {
  return {
    status: "ready",
    ownerId: requestId,
    expiresAtMs: Date.now() + 120_000,
    writeCustody: [{ phase: "writes", count: 0 }],
    ...extra,
  };
}
function prepared(extra = {}) {
  return { ...status(), suspensionId, activeCount: 0, blockers: [], ...extra };
}
function run<T>(callback: (scope: GatewayMigrationQuiescenceScope) => Promise<T>) {
  return withGatewayMigrationQuiescence({
    env: { OPENCLAW_STATE_DIR: directory, OPENCLAW_GATEWAY_URL: "ws://unselected.invalid" },
    signal: outer.signal,
    assertCurrent() {},
    requestId,
    suspensionId,
    run: callback,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
  vi.resetAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-quiescence-"));
  ownerPath = path.join(directory, "owner.lock");
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(configPath, "{}");
  fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, configPath, stateDir: directory }));
  mocks.paths.mockReturnValue({
    stateDir: directory,
    configPath,
    ownerLockPath: ownerPath,
    configLockPath: path.join(directory, "config.lock"),
    stateLockPath: path.join(directory, "state.lock"),
  });
  mocks.readLock.mockImplementation((file: string) =>
    fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null,
  );
  mocks.discover.mockResolvedValue(owner);
  mocks.config.mockResolvedValue({ valid: true, config: { gateway: { mode: "local" } } });
  mocks.auth.mockReturnValue({ mode: "password", password: "synthetic-private-shared-password" });
  mocks.alive.mockReturnValue(true);
  mocks.start.mockReturnValue(owner.startTime);
  mocks.rpc.mockImplementation(async (options: CallGatewayOptions) => {
    options.assertDispatchCurrent?.();
    return options.method === "gateway.suspend.status" ? status() : prepared();
  });
  outer = new AbortController();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("borrowed Gateway migration quiescence", () => {
  it("renews only the existing suspension, keeps source inputs unchanged and exposes latest expiry", async () => {
    const bytes = fs.readFileSync(ownerPath);
    const before = fs.statSync(ownerPath, { bigint: true });
    await run(async (scope) => {
      const initialExpiry = scope.expiresAtMs;
      expect(scope.owner).toEqual(owner);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(scope.expiresAtMs).toBe(initialExpiry + 30_000);
      await scope.revalidate();
      scope.assertCurrent();
    });
    expect(fs.readFileSync(ownerPath)).toEqual(bytes);
    const after = fs.statSync(ownerPath, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(mocks.rpc.mock.calls.map(([call]) => call.method)).toEqual([
      "gateway.suspend.status",
      "gateway.suspend.prepare",
      "gateway.suspend.status",
      "gateway.suspend.prepare",
      "gateway.suspend.status",
      "gateway.suspend.prepare",
    ]);
    for (const [call] of mocks.rpc.mock.calls) {
      expect(call).toMatchObject({
        localPortOverride: owner.port,
        ignoreEnvUrlOverride: true,
        deviceIdentity: null,
        skipImplicitAuth: true,
        sharedStateMode: "read-only",
        requireLocalBackendSharedAuth: true,
      });
      expect(call.params).toEqual(
        call.method === "gateway.suspend.status"
          ? { suspensionId, includeLifecycle: true }
          : { requestId, drain: false, terminalPolicy: "preserve" },
      );
    }
  });

  it.each([
    { status: "running" },
    { status: "draining" },
    { ownerId: "another-controller" },
    { writeCustody: undefined },
    { writeCustody: [{ phase: "writes", count: 1 }] },
    { expiresAtMs: 1 },
  ])("rejects existing suspension uncertainty before prepare: %j", async (extra) => {
    mocks.rpc.mockResolvedValue(status(extra));
    const callback = vi.fn();
    await expect(run(callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { suspensionId: "new-suspension" },
    { activeCount: 1 },
    { blockers: ["pending-write"] },
    { status: "draining" },
    { writeCustody: [{ phase: "writes", count: 1 }] },
  ])("refuses an unsafe renewal without running capture: %j", async (extra) => {
    mocks.rpc.mockResolvedValueOnce(status()).mockResolvedValueOnce(prepared(extra));
    const callback = vi.fn();
    await expect(run(callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it.each(["none", "remote"])("rejects %s access before any control request", async (mode) => {
    if (mode === "none") {
      mocks.auth.mockReturnValue({ mode: "none" });
    } else {
      mocks.config.mockResolvedValue({ valid: true, config: { gateway: { mode: "remote" } } });
    }
    await expect(run(vi.fn())).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("aborts capture on physical owner replacement even with identical payload", async () => {
    await expect(
      run(async (scope) => {
        const replacement = `${ownerPath}.replacement`;
        fs.copyFileSync(ownerPath, replacement);
        fs.renameSync(replacement, ownerPath);
        expect(() => scope.assertCurrent()).toThrow("owner identity changed");
        expect(scope.signal.aborted).toBe(true);
      }),
    ).rejects.toThrow("owner identity changed");
  });

  it("rejects recycled process identity", async () => {
    await expect(
      run(async (scope) => {
        mocks.start.mockReturnValue(owner.startTime + 1);
        scope.assertCurrent();
      }),
    ).rejects.toThrow("owner identity changed");
  });

  it("does not extend authority when the wall clock rolls back", async () => {
    await expect(
      run(async (scope) => {
        const current = performance.now();
        vi.setSystemTime(new Date("2026-10-28T23:59:00Z"));
        vi.spyOn(performance, "now").mockReturnValue(current + 120_001);
        scope.assertCurrent();
      }),
    ).rejects.toThrow("suspension expired");
  });

  it("aborts the linked run and prevents completion after renewal failure", async () => {
    await expect(
      run(async (scope) => {
        mocks.rpc.mockRejectedValue(new Error("renewal transport unavailable"));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(scope.signal.aborted).toBe(true);
        scope.assertCurrent();
      }),
    ).rejects.toThrow("renewal transport unavailable");
  });

  it("joins an accepted in-flight renewal before returning", async () => {
    let release!: (value: unknown) => void;
    let finished = false;
    const operation = run(async () => {
      mocks.rpc.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(release).toBeTypeOf("function");
      return "captured";
    }).then((value) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(finished).toBe(false);
    release(status());
    await expect(operation).resolves.toBe("captured");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates parent cancellation without resume or stop", async () => {
    await expect(
      run(async (scope) => {
        outer.abort(new Error("capture cancelled"));
        expect(scope.signal.aborted).toBe(true);
        scope.assertCurrent();
      }),
    ).rejects.toThrow("capture cancelled");
    expect(mocks.rpc.mock.calls.map(([call]) => call.method)).toEqual([
      "gateway.suspend.status",
      "gateway.suspend.prepare",
    ]);
  });
});
