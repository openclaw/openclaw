// Managed-service handoff command tests cover immutable update target serialization.
import { EventEmitter } from "node:events";
import { symlinkSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findSystemdGatewayInstallation } from "../daemon/systemd-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnv } from "../test-utils/env.js";
import { readDevUpdateTarget } from "./update-dev-target.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease.js";
import type { ManagedServiceUpdateHandoffParams } from "./update-managed-service-handoff-types.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const forceKillChildProcessTreeMock = vi.hoisted(() => vi.fn());
const tempDirs = createManagedHandoffTempDirTracker();
const mockedHandoffLeaseCleanups = new Set<() => void>();
const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-command-${process.pid}`);
const systemRoots = useAutoCleanupTempDirTracker(afterEach);

function createReadyChild(_command: string, args: string[], readyDelayMs = 0) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  const ready = () =>
    signalMockManagedUpdateHandoffReady({
      child,
      paramsPath: readManagedHandoffArtifacts(args).paramsPath,
      cleanups: mockedHandoffLeaseCleanups,
    });
  process.nextTick(() => (readyDelayMs > 0 ? setTimeout(ready, readyDelayMs) : ready()));
  return child;
}

function captureSpawn(readyDelayMs = 0) {
  const spawned = createDeferredCore<ReturnType<typeof createReadyChild>>();
  spawnMock.mockImplementationOnce((command: string, args: string[]) => {
    const child = createReadyChild(command, args, readyDelayMs);
    tempDirs.add(readManagedHandoffArtifacts(args).dir);
    spawned.resolve(child);
    return child;
  });
  return spawned.promise;
}

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
    spawnSync: spawnSyncMock,
  });
});

vi.mock("../process/child-process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: forceKillChildProcessTreeMock,
}));

vi.mock("../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-scope.js")>()),
  findSystemdGatewayInstallation: vi.fn(async () => ({ kind: "none" })),
}));

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

beforeEach(async () => {
  vi.mocked(findSystemdGatewayInstallation).mockResolvedValue({ kind: "none" });
  // Helpers in one fixture share a coordinator without touching the operator's database.
  const coordinatorDir = await fs.realpath(tempDirs.make("openclaw-handoff-coordinator-"));
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  forceKillChildProcessTreeMock.mockReset();
  spawnMock.mockReset();
  spawnSyncMock
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync,
    );
  spawnMock.mockImplementation((command: string, args: string[]) =>
    createReadyChild(command, args),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of mockedHandoffLeaseCleanups) {
    mockedHandoffLeaseCleanups.delete(cleanup);
    cleanup();
  }
  await tempDirs.cleanup();
  vi.resetModules();
});

async function startHandoff(params: Partial<ManagedServiceUpdateHandoffParams> = {}) {
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  return startManagedServiceUpdateHandoff({
    root: MOCK_INSTALL_ROOT,
    restartDrainTimeoutMs: 300_000,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    meta: {},
    ...params,
  });
}

async function readSpawn<T = Record<string, unknown>>() {
  const [spawnCommand, spawnArgs, options] = expectDefined(
    spawnMock.mock.calls[0],
    "handoff spawn",
  ) as [string, string[], { env?: NodeJS.ProcessEnv }];
  const { dir, paramsPath } = readManagedHandoffArtifacts(spawnArgs);
  tempDirs.add(dir);
  return {
    spawnCommand,
    spawnArgs,
    spawnEnv: options?.env,
    paramsPath,
    helperParams: JSON.parse(await fs.readFile(paramsPath, "utf8")) as T,
  };
}

async function startHandoffAndReadCommand({
  runtime = "node",
  ...params
}: Partial<ManagedServiceUpdateHandoffParams> & { runtime?: "node" | "bun" }) {
  const result = await startHandoff({
    channel: "beta",
    execPath: `/usr/local/bin/${runtime}`,
    ...params,
  });
  expect(forceKillChildProcessTreeMock).not.toHaveBeenCalled();
  const { paramsPath, spawnEnv, helperParams } = await readSpawn<{
    commandArgv?: string[];
    recoveryCommandArgv: string[];
    triageCommandArgv: string[];
    triageContextCommand: string;
    parentExitTimeoutMs: number;
    parentExitDeadlineAt: number;
  }>();
  const metaPath = path.join(path.dirname(paramsPath), "sentinel-meta.json");
  const metaFile = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
    meta?: { root?: string; runId?: string };
  };
  expect(metaFile.meta?.root).toBe(
    await fs.realpath(MOCK_INSTALL_ROOT).catch(() => path.resolve(MOCK_INSTALL_ROOT)),
  );
  expect(metaFile.meta?.runId).toBe(params.runId);
  return {
    ...helperParams,
    command: result.command,
    spawnEnv,
  };
}

describe("managed service update handoff command", () => {
  it("pins update, recovery, and triage before the detached helper starts", async () => {
    const root = await fs.realpath(systemRoots.make("openclaw-handoff-launcher-"));
    const releaseA = path.join(root, "release-a");
    const releaseB = path.join(root, "release-b");
    for (const release of [releaseA, releaseB]) {
      await fs.mkdir(release);
      await fs.writeFile(path.join(release, "openclaw.mjs"), "export {};\n");
    }
    const current = path.join(root, "current");
    await fs.symlink(releaseA, current, "junction");
    spawnMock.mockImplementationOnce((command: string, args: string[]) => {
      unlinkSync(current);
      symlinkSync(releaseB, current, "junction");
      return createReadyChild(command, args);
    });

    const prepared = await startHandoffAndReadCommand({
      argv1: path.join(current, "openclaw.mjs"),
    });
    expect(prepared.triageCommandArgv.slice(-3)).toEqual(["triage", "--json", "--non-interactive"]);
    expect(prepared.triageContextCommand).toContain("openclaw triage --run --update-result");
    for (const argv of [
      prepared.commandArgv,
      prepared.recoveryCommandArgv,
      prepared.triageCommandArgv,
    ]) {
      expect(await fs.realpath(expectDefined(argv?.[1], "prepared handoff entry"))).toBe(
        path.join(releaseA, "openclaw.mjs"),
      );
    }
  });

  it.each([
    { writable: false, signal: null, code: 0, receipt: false },
    { writable: true, signal: null, code: 0, receipt: true },
    { writable: true, signal: "SIGKILL", code: null, receipt: true },
    { writable: true, signal: null, code: 143, receipt: false },
  ])(
    "admits writable=$writable system updates and joins helper settlement (code=$code, signal=$signal, receipt=$receipt)",
    async ({ writable, signal, code, receipt }) => {
      const root = systemRoots.make("openclaw-system-update-");
      const unitName = "openclaw-custom.service";
      vi.mocked(findSystemdGatewayInstallation).mockResolvedValue({
        kind: "system",
        system: {
          scope: "system",
          unitName,
          unitPath: `/etc/systemd/system/${unitName}`,
        },
      });
      if (!writable) {
        const access = fs.access.bind(fs);
        vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
          if (
            String(file) === (await fs.realpath(root)) &&
            mode === (fs.constants.W_OK | fs.constants.X_OK)
          ) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return access(file, mode);
        });
      }
      const { waitForSystemServiceUpdateHandoffs } =
        await import("./update-managed-service-handoff.js");
      expect(waitForSystemServiceUpdateHandoffs()).toBeUndefined();
      const spawned = captureSpawn();
      const started = startHandoff({
        root,
        parentPid: undefined,
        supervisor: "systemd",
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        execPath: process.execPath,
        argv1: path.join(root, "openclaw.mjs"),
      });
      if (!writable) {
        await expect(started).rejects.toMatchObject({
          reason: "managed-service-handoff-failed",
          message: expect.stringContaining(`sudo systemctl restart ${unitName}`),
        });
        expect(spawnMock).not.toHaveBeenCalled();
        return;
      }
      const result = await started;
      expect(result).toMatchObject({ status: "started" });
      const { spawnCommand, helperParams: prepared } = await readSpawn();
      expect(spawnCommand).toBe(process.execPath);
      expect(prepared.commandArgv).toContain("--no-restart");
      expect(prepared.serviceRecovery).toBeUndefined();
      expect(prepared.operatorRestartWarning).toBe(
        `System-scope Gateway service ${unitName} requires an operator restart. Package updates do not stop or restart this service. After the update, run: sudo systemctl restart ${unitName}`,
      );
      const barrier = waitForSystemServiceUpdateHandoffs();
      expect(barrier).toBeDefined();
      const settled = vi.fn();
      const observed = barrier?.then(settled, settled);
      const child = await spawned;
      // Model the helper's completion receipt independently of its exit code.
      if (receipt) {
        child.stdout.write("system-update-settled\n");
      }
      Object.assign(child, { exitCode: code, signalCode: signal });
      child.emit("exit", code, signal);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      child.emit("close", code, signal);
      if (signal || !receipt) {
        await expect(barrier).rejects.toThrow("settlement could not be confirmed");
      } else {
        await expect(barrier).resolves.toBeUndefined();
      }
      await observed;
    },
  );

  it.each(
    (["readiness", "park"] as const).flatMap((phase) =>
      [30_000, 120_000].map((budgetMs) => ({ phase, budgetMs })),
    ),
  )(
    "waits for delayed $phase ACKs within the owning $budgetMs ms budget",
    async ({ phase, budgetMs }) => {
      const { requestManagedServiceUpdateHandoffPark } =
        await import("./update-managed-service-handoff.js");
      const spawned = captureSpawn(phase === "readiness" ? 31_000 : 0);
      vi.useFakeTimers();
      let child: ReturnType<typeof createReadyChild> | undefined;
      try {
        const starting = startHandoff({
          timeoutMs: phase === "readiness" ? budgetMs : 5_000,
          restartDrainTimeoutMs: phase === "park" ? budgetMs - 30_000 : 300_000,
        }).then(
          (value) => ({ kind: "ready" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        child = await spawned;
        if (phase === "readiness") {
          await vi.advanceTimersByTimeAsync(31_000);
        }
        const started = await starting;
        if (phase === "readiness" && budgetMs === 30_000) {
          expect(started).toMatchObject({
            kind: "rejected",
            error: { message: "managed update handoff did not signal readiness within 30 seconds" },
          });
          expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
          return;
        }
        expect(started.kind).toBe("ready");
        if (started.kind !== "ready" || started.value.status !== "started") {
          throw new Error("expected a ready owned helper");
        }
        if (phase === "park") {
          const requested = createDeferredCore();
          const output = child.stdout;
          child.stdin.on("data", (chunk: Buffer) => {
            if (chunk.toString() === "park\n") {
              setTimeout(() => output.write("parked\n"), 31_000);
              requested.resolve();
            }
          });
          const parked = requestManagedServiceUpdateHandoffPark({
            kind: "managed-update-handoff",
            ...started.value,
          });
          await requested.promise;
          await vi.advanceTimersByTimeAsync(31_000);
          expect(await parked).toBe(budgetMs === 120_000);
        }
        expect(forceKillChildProcessTreeMock).not.toHaveBeenCalled();
      } finally {
        child?.emit("exit", 0, null);
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { runtime: "node", runtimeArgs: [] },
    { runtime: "bun", runtimeArgs: ["--no-install"] },
  ])(
    "stages automatic triage in a stop-linked scope using $runtime",
    async ({ runtime, runtimeArgs }) => {
      const root = tempDirs.make("openclaw-triage-command-");
      const executable = path.join(root, runtime);
      await fs.writeFile(path.join(root, "systemd-run"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await startHandoff({
        root,
        parentPid: undefined,
        argv1: undefined,
        restartDrainTimeoutMs: 0,
        supervisor: "systemd",
        env: {
          PATH: root,
          OPENCLAW_STATE_DIR: root,
        },
        handoffId: "triage-fixture",
        execPath: executable,
        action: {
          kind: "triage" as const,
          entrypoint: path.join(root, "dist/index.js"),
          nodeRunner: executable,
          failure: {
            kind: "gateway-startup" as const,
            phase: "startup",
            error: "bad certificate",
            gateway: "verify-running" as const,
          },
        },
      });
      const { spawnArgs: args, helperParams: staged } = await readSpawn();
      expect(args).toContain("--property=PartOf=openclaw-gateway.service");
      expect(args.slice(args.indexOf(executable) + 1, -2)).toEqual(runtimeArgs);
      expect(staged.runtimeArgs).toEqual(runtimeArgs);
      expect(staged.commandArgv).toEqual([
        executable,
        ...runtimeArgs,
        path.join(root, "dist/index.js"),
        "triage",
      ]);
    },
  );

  it.each([
    { drain: 300_000, expected: 330_000 },
    { drain: Number.MAX_SAFE_INTEGER, expected: 2_147_483_647 },
  ])(
    "serializes a bounded timer-safe restart deadline for drain $drain",
    async ({ drain, expected }) => {
      const startedAt = Date.now();
      const result = await startHandoffAndReadCommand({
        restartDelayMs: 60_000,
        restartDrainTimeoutMs: drain,
      });

      expect(result.parentExitTimeoutMs).toBe(expected);
      expect(result.parentExitDeadlineAt).toBeGreaterThanOrEqual(startedAt + expected);
      expect(result.parentExitDeadlineAt).toBeLessThanOrEqual(Date.now() + expected);
    },
  );

  it("confirms native group cleanup after a scope is collected, without stopping a replaced scope", async () => {
    const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } =
      await import("./update-managed-service-handoff-lease.js");
    const { prepareManagedHandoffLeaseDatabase } =
      await import("./update-managed-service-handoff-database.js");
    const store = createManagedHandoffLeaseStore();
    const lifetime = {
      kind: "native" as const,
      scope: "synthetic.scope",
      unit: "synthetic.service",
      placement: { kind: "attached" as const, invocation: "a".repeat(32) },
    };
    const action = { kind: "triage" as const, phase: "closing" as const, lifetime };
    const identity = { pid: 123, startIdentity: "17" };
    const identities = { version: 2 as const, executor: identity, helper: identity, action };
    const payload = JSON.stringify(identities);
    const lease: ManagedHandoffLease = {
      ...identities,
      key: MOCK_INSTALL_ROOT,
      owner: "synthetic",
      updatedAt: 1,
      payload,
    };
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    const withDatabase = await prepareManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (db) =>
      db
        .prepare(
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(lease.key, lease.owner, payload, 1),
    );
    mockedHandoffLeaseCleanups.add(() => {
      withDatabase(true, (db) =>
        db
          .prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?")
          .run(lease.key, lease.owner),
      );
    });
    const scopeResult = (invocation: string, active = "active", loaded = "loaded") => ({
      status: loaded === "loaded" ? 0 : 1,
      stdout: `Id=synthetic.scope\nLoadState=${loaded}\nActiveState=${active}\n${loaded === "loaded" && active !== "active" ? "ControlGroup=\n" : ""}InvocationID=${invocation}`,
    });
    const stopCalls = () => spawnSyncMock.mock.calls.filter(([, args]) => args.includes("stop"));
    spawnSyncMock
      .mockReturnValueOnce(scopeResult("a".repeat(32)))
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce(scopeResult("", "inactive", "not-found"));
    expect(store.stopNative(lease)).toBe(true);
    expect(stopCalls()).toHaveLength(1);
    spawnSyncMock.mockReset().mockReturnValue(scopeResult("b".repeat(32)));
    expect(store.stopNative(lease)).toBe(false);
    expect(stopCalls()).toEqual([]);
    for (const state of ["inactive", "failed"]) {
      spawnSyncMock.mockReset().mockReturnValue(scopeResult("b".repeat(32), state));
      expect(store.stopNative(lease)).toBe(false);
      expect(stopCalls()).toEqual([]);
    }
  });

  it.each([
    ["reapplyLocalOverrides", "--reapply-local-overrides", true],
    ["reapplyLocalOverrides", "--reapply-local-overrides", false],
    ["fullIntegrityCheck", "--full-integrity-check", true],
    ["fullIntegrityCheck", "--full-integrity-check", false],
  ] as const)("preserves %s (%s=%s) across handoff", async (option, flag, enabled) => {
    const result = await startHandoffAndReadCommand({ [option]: enabled });
    expect(result.commandArgv?.includes(flag)).toBe(enabled);
    expect(result.command.includes(flag)).toBe(enabled);
  });

  it.each(["auto", "installed"] as const)(
    "preserves %s admission through the detached CLI command",
    async (admission) => {
      const result = await startHandoffAndReadCommand({ admission });
      const flagIndex = result.commandArgv?.indexOf("--admission") ?? -1;
      expect(flagIndex).toBeGreaterThan(0);
      expect(result.commandArgv?.[flagIndex + 1]).toBe(admission);
      expect(result.command).toContain(`--admission ${admission}`);
    },
  );

  it.each(["node", "bun"] as const)(
    "serializes an immutable package target into the detached %s command",
    async (runtime) => {
      const result = await startHandoffAndReadCommand({
        runtime,
        tag: "2.0.0-beta.1",
        acceptCapabilities: true,
      });

      expect(result.commandArgv).toEqual([
        `/usr/local/bin/${runtime}`,
        ...(runtime === "bun" ? ["--no-install"] : []),
        "/opt/openclaw/openclaw.mjs",
        ..."update --yes --json --accept-capabilities --channel beta --tag 2.0.0-beta.1".split(" "),
      ]);
      expect(result.command).toContain("--tag 2.0.0-beta.1");
      expect(result.command).toContain("--channel beta");
      expect(result.command).toContain("--accept-capabilities");
      expect(result.command).toContain("--yes");
      expect(result.command).not.toContain("--json");
    },
  );

  it("merges a tracked target into the child environment without replacing caller fields", async () => {
    const runId = "970895bf-61e5-48e6-b0f6-468ce6f8e33a";
    const result = await startHandoffAndReadCommand({
      runId,
      env: {
        KEEP: "value",
        OPENCLAW_UPDATE_DEV_TARGET_REF: "stale-ref",
      },
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: "frozen-sha",
      },
    });

    expect(result.spawnEnv?.KEEP).toBe("value");
    expect(result.spawnEnv?.OPENCLAW_UPDATE_RUN_ID).toBe(runId);
    expect(
      withEnv(
        { OPENCLAW_UPDATE_DEV_TARGET_REF: result.spawnEnv?.OPENCLAW_UPDATE_DEV_TARGET_REF },
        readDevUpdateTarget,
      ),
    ).toEqual({
      mode: "tracked",
      upstreamRef: "origin/main",
      upstreamSha: "frozen-sha",
    });
  });
});
