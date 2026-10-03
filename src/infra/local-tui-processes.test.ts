import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secureTempRoot = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-local-tui-update-501"));

vi.mock("@openclaw/fs-safe/temp", () => ({ resolveSecureTempRoot: secureTempRoot }));
import {
  announceLocalTuiUpdate,
  discoverLocalTuiProcesses,
  type LocalTuiProcess,
  preflightLocalTuiProcessesBeforeUpdate,
  quiesceLocalTuiProcessesBeforeUpdate,
  terminateLocalTuiProcesses,
  waitForLocalTuiUpdate,
} from "./local-tui-processes.js";
import { resolveOpenClawInstallationId } from "./openclaw-installation-id.js";

function listLocalTuiProcesses(
  params: Parameters<typeof discoverLocalTuiProcesses>[0],
): LocalTuiProcess[] {
  const discovery = discoverLocalTuiProcesses(params);
  return discovery.ok ? discovery.processes : [];
}

const noUpdateProcesses: typeof discoverLocalTuiProcesses = () => ({ ok: true, processes: [] });
const POSIX_START_IDENTITY = "Tue Sep 30 09:30:00 2026";

function posixProcessLine(uid: number, pid: number, command: string, ppid = 1): string {
  return `${uid} ${pid} ${ppid} ${POSIX_START_IDENTITY} ${command}`;
}

function fixtureProcess(
  pid: number,
  command: string,
  ownership: LocalTuiProcess["ownership"],
  startIdentity = `start-${pid}`,
): LocalTuiProcess {
  return { pid, startIdentity, command, ownership };
}

describe("local TUI processes", () => {
  beforeEach(() => secureTempRoot.mockReturnValue("/tmp/openclaw-local-tui-update-501"));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("discovers target, ambiguous, and foreign-user POSIX clients", () => {
    const targetId = resolveOpenClawInstallationId("/target");
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        posixProcessLine(501, 100, `openclaw-tui@${targetId}`),
        posixProcessLine(501, 101, "openclaw-tui@trun"),
        posixProcessLine(501, 102, "/usr/bin/node /target/openclaw.mjs resume session"),
        posixProcessLine(502, 103, "/target/bin/openclaw chat"),
        posixProcessLine(501, 104, `openclaw-tui@${targetId}#101`, 101),
        posixProcessLine(501, 112, "openclaw tui"),
        posixProcessLine(501, 105, "/other/bin/openclaw tui"),
        posixProcessLine(501, 106, "openclaw-resume"),
        posixProcessLine(501, 107, "openclaw-chat"),
        posixProcessLine(501, 108, "openclaw-terminal"),
        posixProcessLine(502, 109, "openclaw-resume"),
        posixProcessLine(501, 110, "openclaw"),
        posixProcessLine(501, 111, "/target/bin/openclaw"),
        posixProcessLine(501, 999, "/target/bin/openclaw tui"),
      ].join("\n"),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));

    expect(
      listLocalTuiProcesses({
        targetRoot: "/target",
        platform: "linux",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual([
      fixtureProcess(100, `openclaw-tui@${targetId}`, "target", POSIX_START_IDENTITY),
      fixtureProcess(
        102,
        "/usr/bin/node /target/openclaw.mjs resume session",
        "target",
        POSIX_START_IDENTITY,
      ),
      fixtureProcess(103, "/target/bin/openclaw chat", "foreign-user", POSIX_START_IDENTITY),
      fixtureProcess(101, `openclaw-tui@${targetId}#101`, "target", POSIX_START_IDENTITY),
      fixtureProcess(112, "openclaw tui", "ambiguous", POSIX_START_IDENTITY),
      fixtureProcess(106, "openclaw-resume", "ambiguous", POSIX_START_IDENTITY),
      fixtureProcess(107, "openclaw-chat", "ambiguous", POSIX_START_IDENTITY),
      fixtureProcess(108, "openclaw-terminal", "ambiguous", POSIX_START_IDENTITY),
      fixtureProcess(109, "openclaw-resume", "ambiguous", POSIX_START_IDENTITY),
      fixtureProcess(111, "/target/bin/openclaw", "target", POSIX_START_IDENTITY),
    ]);
    expect(spawnSync).toHaveBeenCalledWith(
      "ps",
      ["-axo", "uid=,pid=,ppid=,lstart=,command="],
      expect.objectContaining({
        encoding: "utf8",
        env: expect.objectContaining({ LC_ALL: "C" }),
        killSignal: "SIGKILL",
        timeout: 1_000,
      }),
    );
  });

  it("rejects a POSIX announcement that no longer belongs to its advertised parent", () => {
    const targetId = resolveOpenClawInstallationId("/target");
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        posixProcessLine(501, 101, "/usr/bin/unrelated-runtime"),
        posixProcessLine(501, 104, `openclaw-tui@${targetId}#101`, 1),
      ].join("\n"),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));

    expect(
      listLocalTuiProcesses({
        targetRoot: "/target",
        platform: "darwin",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual([]);
  });

  it("prefilters and discovers target and foreign-user Windows clients", () => {
    const targetId = resolveOpenClawInstallationId("C:\\OpenClaw");
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          ProcessId: 101,
          CreationDate: "20260930093000.000000-000",
          CommandLine:
            '"C:\\Program Files\\nodejs\\Node.EXE" --stack-size=8192 "C:\\OpenClaw\\OpenClaw.MJS" resume session',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 102,
          CreationDate: "20260930093001.000000-000",
          CommandLine: '"C:\\OpenClaw\\OpenClaw.EXE" tui',
          OwnerSid: "S-2",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 103,
          CreationDate: "20260930093002.000000-000",
          CommandLine: '"C:\\Other\\openclaw.exe" tui',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 104,
          CreationDate: "20260930093003.000000-000",
          CommandLine: `"C:\\Program Files\\nodejs\\Node.EXE" -e fixture openclaw-process-announcement 999 openclaw-tui@${targetId}`,
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
      ]),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));

    expect(
      listLocalTuiProcesses({
        targetRoot: "C:\\OpenClaw",
        platform: "win32",
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual([
      fixtureProcess(
        101,
        '"C:\\Program Files\\nodejs\\Node.EXE" --stack-size=8192 "C:\\OpenClaw\\OpenClaw.MJS" resume session',
        "target",
        "20260930093000.000000-000",
      ),
      fixtureProcess(
        102,
        '"C:\\OpenClaw\\OpenClaw.EXE" tui',
        "foreign-user",
        "20260930093001.000000-000",
      ),
      fixtureProcess(
        104,
        `"C:\\Program Files\\nodejs\\Node.EXE" -e fixture openclaw-process-announcement 999 openclaw-tui@${targetId}`,
        "companion",
        "20260930093003.000000-000",
      ),
    ]);
    expect(spawnSync.mock.calls[0]?.[1]).toContain("-Command");
    expect(String(spawnSync.mock.calls[0]?.[1]?.at(-1))).toContain("Where-Object");
  });

  it("discovers activation announcements and excludes idle update launchers", () => {
    const targetId = resolveOpenClawInstallationId("/target");
    const otherId = resolveOpenClawInstallationId("/other");
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        posixProcessLine(501, 201, `openclaw-update@${targetId}`),
        posixProcessLine(502, 202, `openclaw-update@${targetId}`),
        posixProcessLine(501, 203, `openclaw-update@${otherId}`),
        posixProcessLine(501, 204, "/target/bin/openclaw update wizard"),
        posixProcessLine(501, 205, "/usr/bin/node /target/openclaw.mjs update wizard"),
        posixProcessLine(501, 206, `/usr/bin/node -e fixture 123 openclaw-update@${targetId}`),
      ].join("\n"),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));

    expect(
      discoverLocalTuiProcesses({
        targetRoot: "/target",
        processKind: "update",
        platform: "linux",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
      }),
    ).toEqual({
      ok: true,
      processes: [
        fixtureProcess(201, `openclaw-update@${targetId}`, "target", POSIX_START_IDENTITY),
        fixtureProcess(202, `openclaw-update@${targetId}`, "foreign-user", POSIX_START_IDENTITY),
      ],
    });
  });

  it("keeps one installation identity across a pnpm version switch", () => {
    const stableRoot = "/prefix/node_modules/openclaw";
    const oldRoot = "/prefix/node_modules/.pnpm/openclaw@1.0.0/node_modules/openclaw";
    const nextRoot = "/prefix/node_modules/.pnpm/openclaw@2.0.0/node_modules/openclaw";
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) =>
      String(value) === stableRoot ? nextRoot : String(value),
    );

    expect(resolveOpenClawInstallationId(stableRoot)).toBe(resolveOpenClawInstallationId(oldRoot));
    expect(resolveOpenClawInstallationId(nextRoot)).toBe(resolveOpenClawInstallationId(oldRoot));
  });

  it("keeps discovery failure distinct from an empty advisory list", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "" });
    expect(discoverLocalTuiProcesses({ platform: "linux", currentUid: 501, spawnSync })).toEqual({
      ok: false,
      error: "POSIX process discovery failed.",
    });
    expect(listLocalTuiProcesses({ platform: "linux", currentUid: 501, spawnSync })).toEqual([]);
  });

  it("revalidates target ownership and authority before both signals", async () => {
    const alive = new Set([101]);
    const signals: Array<string | number> = [];
    const controller = {
      kill: vi.fn((_pid: number, signal: string | number) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          alive.delete(101);
        }
        if (signal === 0 && !alive.has(101)) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      }),
    };
    const readCurrentTarget = vi.fn(() => "target" as const);
    const assertCurrent = vi.fn();

    await expect(
      terminateLocalTuiProcesses({
        processes: [fixtureProcess(101, "/target/openclaw tui", "target")],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentTarget,
        assertCurrent,
      }),
    ).resolves.toEqual({ stopped: [101], failed: [] });
    expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]);
    expect(readCurrentTarget).toHaveBeenCalledTimes(2);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("does not signal a replacement process that reuses the discovered PID", async () => {
    const signals: Array<string | number> = [];
    const controller = {
      kill: vi.fn((_pid: number, signal: string | number) => {
        signals.push(signal);
        return true;
      }),
    };
    const discover = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        processes: [fixtureProcess(101, "/target/openclaw tui", "target", "start-original")],
      })
      .mockReturnValueOnce({
        ok: true,
        processes: [fixtureProcess(101, "/target/openclaw tui", "target", "start-reused")],
      });

    await expect(
      terminateLocalTuiProcesses({
        processes: [fixtureProcess(101, "/target/openclaw tui", "target", "start-original")],
        targetRoot: "/target",
        controller,
        discover,
        graceMs: 0,
        killGraceMs: 0,
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });

    expect(signals).toEqual([0, "SIGTERM", 0]);
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it("honors the configured terminal deadline before escalating to SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS", "300000");
      const controller = { kill: vi.fn(() => true) };
      const termination = terminateLocalTuiProcesses({
        processes: [fixtureProcess(101, "/target/openclaw tui", "target")],
        targetRoot: "/target",
        controller,
        killGraceMs: 0,
        readCurrentTarget: () => "target",
      });

      await vi.advanceTimersByTimeAsync(301_999);
      expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      await termination;
      expect(controller.kill).toHaveBeenCalledWith(101, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes quiescence as soon as the client exits", async () => {
    const alive = new Set([101]);
    const controller = {
      kill: vi.fn((_pid: number, signal: string | number) => {
        if (signal === "SIGTERM") {
          alive.delete(101);
        }
        if (signal === 0 && !alive.has(101)) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      }),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [fixtureProcess(101, "/target/openclaw tui", "target")],
        targetRoot: "/target",
        controller,
        readCurrentTarget: () => "target",
      }),
    ).resolves.toEqual({ stopped: [101], failed: [] });
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it.each(["gone", "unknown"] as const)(
    "does not signal when revalidation returns %s",
    async (current) => {
      const controller = { kill: vi.fn(() => true) };
      await expect(
        terminateLocalTuiProcesses({
          processes: [fixtureProcess(101, "/target/openclaw tui", "target")],
          targetRoot: "/target",
          controller,
          graceMs: 0,
          killGraceMs: 0,
          readCurrentTarget: () => current,
        }),
      ).resolves.toEqual(
        current === "gone" ? { stopped: [101], failed: [] } : { stopped: [], failed: [101] },
      );
      expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGTERM");
    },
  );

  it("keeps a live client unresolved when revalidation loses its owner", async () => {
    const controller = { kill: vi.fn(() => true) };
    await expect(
      terminateLocalTuiProcesses({
        processes: [fixtureProcess(101, "/target/openclaw tui", "target")],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        discover: () => ({
          ok: true,
          processes: [fixtureProcess(101, "openclaw tui", "foreign-user")],
        }),
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGTERM");
  });

  it("refuses the update when a local TUI cannot be bound to an installation", async () => {
    const release = vi.fn(async () => {});
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: noUpdateProcesses,
        discover: () => ({
          ok: true,
          processes: [fixtureProcess(102, "openclaw tui", "ambiguous")],
        }),
      }),
    ).rejects.toThrow("could not be bound to an installation");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses the update when a verified target TUI survives termination", async () => {
    const release = vi.fn(async () => {});
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: noUpdateProcesses,
        discover: () => ({
          ok: true,
          processes: [fixtureProcess(101, "/target/openclaw tui", "target")],
        }),
        terminate: async () => ({ stopped: [], failed: [101] }),
      }),
    ).rejects.toThrow("could not be stopped");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses the update when discovery itself is unavailable", async () => {
    const release = vi.fn(async () => {});
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: noUpdateProcesses,
        discover: () => ({ ok: false, error: "fixture probe failed." }),
      }),
    ).rejects.toThrow("could not inspect local TUI clients");

    expect(release).toHaveBeenCalledOnce();
  });

  it("blocks a shared update for a target client owned by another user", async () => {
    const release = vi.fn(async () => {});
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: noUpdateProcesses,
        discover: () => ({
          ok: true,
          processes: [fixtureProcess(101, "/target/openclaw tui", "foreign-user")],
        }),
      }),
    ).rejects.toThrow("not owned by the current user are using this installation");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses a Windows TUI companion with close-and-retry guidance", async () => {
    const release = vi.fn(async () => {});
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: noUpdateProcesses,
        discover: () => ({
          ok: true,
          processes: [fixtureProcess(104, "openclaw-tui@fixture", "companion")],
        }),
      }),
    ).rejects.toThrow("cannot be stopped safely from their launch command. Close them, then retry");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses a known Windows companion before candidate validation", () => {
    expect(() =>
      preflightLocalTuiProcessesBeforeUpdate("/target", () => ({
        ok: true,
        processes: [fixtureProcess(104, "openclaw-tui@fixture", "companion")],
      })),
    ).toThrow("Windows TUI clients (104)");
  });

  it("defers unavailable discovery to the authoritative activation gate", () => {
    expect(() =>
      preflightLocalTuiProcessesBeforeUpdate("/target", () => ({
        ok: false,
        error: "fixture probe failed.",
      })),
    ).not.toThrow();
  });

  it("releases the gate if update authority expires after lock contention", async () => {
    const release = vi.fn(async () => {});
    const discover = vi.fn();
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        assertCurrent: () => {
          throw new Error("requester revoked");
        },
        discover,
      }),
    ).rejects.toThrow("requester revoked");
    expect(release).toHaveBeenCalledOnce();
    expect(discover).not.toHaveBeenCalled();
  });

  it("refuses a concurrent updater announced by another account", async () => {
    const release = vi.fn(async () => {});
    const discover = vi.fn();

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: () => ({
          ok: true,
          processes: [fixtureProcess(1, "openclaw-update@0123456789abcdef", "foreign-user")],
        }),
        discover,
      }),
    ).rejects.toThrow("another OpenClaw update (1) is already active");

    expect(discover).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("binds a multi-installation activation announcement to every target", () => {
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));
    const firstId = resolveOpenClawInstallationId("/first");
    const secondId = resolveOpenClawInstallationId("/second");
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: posixProcessLine(502, 202, `openclaw-update@${firstId}+${secondId}`),
    });

    for (const targetRoot of ["/first", "/second"]) {
      expect(
        listLocalTuiProcesses({
          targetRoot,
          processKind: "update",
          platform: "linux",
          currentUid: 501,
          currentPid: 999,
          spawnSync,
        }),
      ).toEqual([
        fixtureProcess(
          202,
          `openclaw-update@${firstId}+${secondId}`,
          "foreign-user",
          POSIX_START_IDENTITY,
        ),
      ]);
    }
  });

  it("does not let same-account lock waiters cancel the selected updater", async () => {
    const release = vi.fn(async () => {});
    const gate = await quiesceLocalTuiProcessesBeforeUpdate("/target", {
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
      discoverUpdates: () => ({
        ok: true,
        processes: [fixtureProcess(1, "openclaw-update@0123456789abcdef", "target")],
      }),
      discover: noUpdateProcesses,
    });

    await gate.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses a later lower-pid updater while another account is active", async () => {
    const release = vi.fn(async () => {});
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: () => ({
          ok: true,
          processes: [
            fixtureProcess(process.pid + 1, "openclaw-update@0123456789abcdef", "foreign-user"),
          ],
        }),
        discover: noUpdateProcesses,
      }),
    ).rejects.toThrow(`another OpenClaw update (${process.pid + 1}) is already active`);

    expect(release).toHaveBeenCalledOnce();
  });

  it("publishes and releases a runtime-independent update announcement", async () => {
    const announcement = await announceLocalTuiUpdate(["/target"]);

    expect(announcement.pid).toBeGreaterThan(0);
    expect(() => process.kill(announcement.pid, 0)).not.toThrow();
    if (process.platform !== "win32" && process.getuid) {
      expect(
        discoverLocalTuiProcesses({
          targetRoot: "/target",
          processKind: "update",
          currentUid: process.getuid(),
          currentPid: -1,
        }),
      ).toMatchObject({
        ok: true,
        processes: expect.arrayContaining([
          expect.objectContaining({ pid: process.pid, ownership: "target" }),
        ]),
      });
    }

    await announcement.release();
    expect(() => process.kill(announcement.pid, 0)).toThrow();
  });

  it("fails closed when concurrent updater discovery is unavailable", async () => {
    const release = vi.fn(async () => {});
    const discover = vi.fn();

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discoverUpdates: () => ({ ok: false, error: "process listing denied" }),
        discover,
      }),
    ).rejects.toThrow("could not inspect concurrent OpenClaw updates");

    expect(discover).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves the refusal when releasing its gate also fails", async () => {
    const refusal = new Error("requester revoked");
    const releaseError = new Error("release failed");
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({
          lockPath: "test",
          release: async () => {
            throw releaseError;
          },
        })),
        assertCurrent: () => {
          throw refusal;
        },
      }),
    ).rejects.toMatchObject({ errors: [refusal, releaseError], cause: releaseError });
  });

  it("uses one canonical gate path for aliases of an installation", async () => {
    const lockPaths: string[] = [];
    const acquireLock = vi.fn(async (lockPath: string) => {
      lockPaths.push(lockPath);
      return { lockPath, release: async () => {} };
    });
    vi.spyOn(fs.realpathSync, "native").mockReturnValue("/canonical/openclaw");
    for (const root of ["/profile-a/openclaw", "/profile-b/openclaw"]) {
      const gate = await quiesceLocalTuiProcessesBeforeUpdate(root, {
        discoverUpdates: noUpdateProcesses,
        discover: () => ({ ok: true, processes: [] }),
        acquireLock,
      });
      await gate.release();
    }
    expect(lockPaths).toHaveLength(2);
    expect(lockPaths[0]).toBe(lockPaths[1]);
  });

  it("isolates installation gates beneath each account's secure temp root", async () => {
    const lockPaths: string[] = [];
    const acquireLock = vi.fn(async (lockPath: string) => {
      lockPaths.push(lockPath);
      return { lockPath, release: async () => {} };
    });
    vi.spyOn(fs.realpathSync, "native").mockReturnValue("/canonical/openclaw");
    secureTempRoot
      .mockReturnValueOnce("/tmp/openclaw-local-tui-update-501")
      .mockReturnValueOnce("/tmp/openclaw-local-tui-update-502");
    for (let account = 0; account < 2; account += 1) {
      const gate = await quiesceLocalTuiProcessesBeforeUpdate("/canonical/openclaw", {
        discoverUpdates: noUpdateProcesses,
        discover: () => ({ ok: true, processes: [] }),
        acquireLock,
      });
      await gate.release();
    }

    expect(lockPaths[0]).not.toBe(lockPaths[1]);
  });

  it("does not classify another TUI's startup contention as an update", async () => {
    const release = vi.fn(async () => {});
    const timeout = Object.assign(new Error("busy"), { code: "file_lock_timeout" });
    const acquireLock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ lockPath: "test", release });
    const onReady = vi.fn();
    await expect(
      waitForLocalTuiUpdate("/target", acquireLock, () => noUpdateProcesses(), onReady),
    ).resolves.toEqual({ waitedForUpdate: false });
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("records lock contention when an updater announcement confirms replacement", async () => {
    const release = vi.fn(async () => {});
    const timeout = Object.assign(new Error("busy"), { code: "file_lock_timeout" });
    const acquireLock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ lockPath: "test", release });
    const discoverUpdates = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        processes: [fixtureProcess(202, "openclaw-update", "target")],
      })
      .mockReturnValueOnce({ ok: true, processes: [] })
      .mockReturnValueOnce({ ok: true, processes: [] });
    const onReady = vi.fn();

    await expect(
      waitForLocalTuiUpdate("/target", acquireLock, discoverUpdates, onReady),
    ).resolves.toEqual({ waitedForUpdate: true });
    expect(discoverUpdates).toHaveBeenCalledTimes(3);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("reports when startup did not cross an update", async () => {
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => ({ lockPath: "test", release }));
    const onReady = vi.fn(async () => {
      expect(release).not.toHaveBeenCalled();
    });

    await expect(
      waitForLocalTuiUpdate("/target", acquireLock, () => noUpdateProcesses(), onReady),
    ).resolves.toEqual({ waitedForUpdate: false });
    expect(onReady).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("waits when another account announces an update during startup publication", async () => {
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => ({ lockPath: "test", release }));
    const discoverUpdates = vi
      .fn()
      .mockReturnValueOnce({ ok: true, processes: [] })
      .mockReturnValueOnce({
        ok: true,
        processes: [fixtureProcess(202, "openclaw-update@0123456789abcdef", "foreign-user")],
      })
      .mockReturnValueOnce({ ok: true, processes: [] })
      .mockReturnValueOnce({ ok: true, processes: [] });
    const withdrawReady = vi.fn();
    const onReady = vi.fn(() => withdrawReady);

    await expect(
      waitForLocalTuiUpdate("/target", acquireLock, discoverUpdates, onReady),
    ).resolves.toEqual({ waitedForUpdate: true });

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(withdrawReady).toHaveBeenCalledOnce();
    expect(withdrawReady).toHaveBeenCalledBefore(release);
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("waits for an updater announced by another account", async () => {
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => ({ lockPath: "test", release }));
    const discoverUpdates = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        processes: [fixtureProcess(202, "openclaw-update@0123456789abcdef", "foreign-user")],
      })
      .mockReturnValueOnce({ ok: true, processes: [] })
      .mockReturnValueOnce({ ok: true, processes: [] });

    await expect(waitForLocalTuiUpdate("/target", acquireLock, discoverUpdates)).resolves.toEqual({
      waitedForUpdate: true,
    });

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(discoverUpdates).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("fails visibly when updater discovery is unavailable", async () => {
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => ({ lockPath: "test", release }));

    await expect(
      waitForLocalTuiUpdate("/target", acquireLock, () => ({
        ok: false,
        error: "process listing denied",
      })),
    ).rejects.toThrow(
      "Unable to inspect local OpenClaw updates before TUI startup: process listing denied",
    );

    expect(acquireLock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
