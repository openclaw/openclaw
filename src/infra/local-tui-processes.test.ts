import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secureTempRoot = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-local-tui-update-501"));

vi.mock("@openclaw/fs-safe/temp", () => ({ resolveSecureTempRoot: secureTempRoot }));
import {
  announceLocalTuiUpdate,
  discoverLocalTuiProcesses,
  type LocalTuiProcess,
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
        `501 100 openclaw-tui@${targetId}`,
        "501 101 /usr/bin/node --stack-size=8192 /target/openclaw.mjs tui",
        "501 102 /usr/bin/node /target/openclaw.mjs resume session",
        "502 103 /target/bin/openclaw chat",
        "501 104 openclaw tui",
        "501 105 /other/bin/openclaw tui",
        "501 106 openclaw-resume",
        "501 107 openclaw-chat",
        "501 108 openclaw-terminal",
        "502 109 openclaw-resume",
        "501 110 openclaw",
        "501 111 /target/bin/openclaw",
        "501 999 /target/bin/openclaw tui",
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
      {
        pid: 100,
        command: `openclaw-tui@${targetId}`,
        ownership: "target",
      },
      {
        pid: 101,
        command: "/usr/bin/node --stack-size=8192 /target/openclaw.mjs tui",
        ownership: "target",
      },
      {
        pid: 102,
        command: "/usr/bin/node /target/openclaw.mjs resume session",
        ownership: "target",
      },
      { pid: 103, command: "/target/bin/openclaw chat", ownership: "foreign-user" },
      { pid: 104, command: "openclaw tui", ownership: "ambiguous" },
      { pid: 106, command: "openclaw-resume", ownership: "ambiguous" },
      { pid: 107, command: "openclaw-chat", ownership: "ambiguous" },
      { pid: 108, command: "openclaw-terminal", ownership: "ambiguous" },
      { pid: 109, command: "openclaw-resume", ownership: "ambiguous" },
      { pid: 111, command: "/target/bin/openclaw", ownership: "target" },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-axo", "uid=,pid=,command="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
  });

  it("prefilters and discovers target and foreign-user Windows clients", () => {
    const targetId = resolveOpenClawInstallationId("C:\\OpenClaw");
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          ProcessId: 101,
          CommandLine:
            '"C:\\Program Files\\nodejs\\node.exe" --stack-size=8192 "C:\\OpenClaw\\openclaw.mjs" resume session',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 102,
          CommandLine: '"C:\\OpenClaw\\openclaw.exe" tui',
          OwnerSid: "S-2",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 103,
          CommandLine: '"C:\\Other\\openclaw.exe" tui',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 104,
          CommandLine: `"C:\\Program Files\\nodejs\\node.exe" -e fixture openclaw-process-announcement 999 openclaw-tui@${targetId}`,
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
      {
        pid: 101,
        command:
          '"C:\\Program Files\\nodejs\\node.exe" --stack-size=8192 "C:\\OpenClaw\\openclaw.mjs" resume session',
        ownership: "target",
      },
      {
        pid: 102,
        command: '"C:\\OpenClaw\\openclaw.exe" tui',
        ownership: "foreign-user",
      },
      {
        pid: 104,
        command: `"C:\\Program Files\\nodejs\\node.exe" -e fixture openclaw-process-announcement 999 openclaw-tui@${targetId}`,
        ownership: "companion",
      },
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
        `501 201 openclaw-update@${targetId}`,
        `502 202 openclaw-update@${targetId}`,
        `501 203 openclaw-update@${otherId}`,
        "501 204 /target/bin/openclaw update wizard",
        "501 205 /usr/bin/node /target/openclaw.mjs update wizard",
        `501 206 /usr/bin/node -e fixture 123 openclaw-update@${targetId}`,
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
        { pid: 201, command: `openclaw-update@${targetId}`, ownership: "target" },
        {
          pid: 202,
          command: `openclaw-update@${targetId}`,
          ownership: "foreign-user",
        },
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
        processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
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

  it("honors the configured terminal deadline before escalating to SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS", "300000");
      const controller = { kill: vi.fn(() => true) };
      const termination = terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
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
        processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
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
          processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
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
        processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        discover: () => ({
          ok: true,
          processes: [{ pid: 101, command: "openclaw tui", ownership: "foreign-user" }],
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
          processes: [{ pid: 102, command: "openclaw tui", ownership: "ambiguous" }],
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
          processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
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
          processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "foreign-user" }],
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
          processes: [{ pid: 104, command: "openclaw-tui@fixture", ownership: "companion" }],
        }),
      }),
    ).rejects.toThrow("cannot be stopped safely from their launch command. Close them, then retry");
    expect(release).toHaveBeenCalledOnce();
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
          processes: [
            {
              pid: 1,
              command: "openclaw-update@0123456789abcdef",
              ownership: "foreign-user",
            },
          ],
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
      stdout: `502 202 openclaw-update@${firstId}+${secondId}`,
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
        {
          pid: 202,
          command: `openclaw-update@${firstId}+${secondId}`,
          ownership: "foreign-user",
        },
      ]);
    }
  });

  it("does not let same-account lock waiters cancel the selected updater", async () => {
    const release = vi.fn(async () => {});
    const gate = await quiesceLocalTuiProcessesBeforeUpdate("/target", {
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
      discoverUpdates: () => ({
        ok: true,
        processes: [
          {
            pid: 1,
            command: "openclaw-update@0123456789abcdef",
            ownership: "target",
          },
        ],
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
            {
              pid: process.pid + 1,
              command: "openclaw-update@0123456789abcdef",
              ownership: "foreign-user",
            },
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

  it("records contention when the next lock acquisition succeeds", async () => {
    const release = vi.fn(async () => {});
    const timeout = Object.assign(new Error("busy"), { code: "file_lock_timeout" });
    const acquireLock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ lockPath: "test", release });
    await expect(waitForLocalTuiUpdate("/target", acquireLock)).resolves.toEqual({
      waitedForUpdate: true,
    });
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports when startup did not cross an update", async () => {
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => ({ lockPath: "test", release }));

    await expect(
      waitForLocalTuiUpdate("/target", acquireLock, () => noUpdateProcesses()),
    ).resolves.toEqual({ waitedForUpdate: false });
  });

  it("waits for an updater announced by another account", async () => {
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async () => ({ lockPath: "test", release }));
    const discoverUpdates = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        processes: [
          { pid: 202, command: "openclaw-update@0123456789abcdef", ownership: "foreign-user" },
        ],
      })
      .mockReturnValueOnce({ ok: true, processes: [] });

    await expect(waitForLocalTuiUpdate("/target", acquireLock, discoverUpdates)).resolves.toEqual({
      waitedForUpdate: true,
    });

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(discoverUpdates).toHaveBeenCalledTimes(2);
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
