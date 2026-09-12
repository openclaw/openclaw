import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as diskSpace from "./disk-space.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  FakeChild,
  stubHealthyGateway,
  useCanaryFixture,
} from "./update-candidate-canary.test-support.js";
import {
  prepareUpdateCandidateRehearsal,
  UpdateCandidateRehearsalInUseError,
} from "./update-candidate-rehearsal.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  snapshot: vi.fn(),
  signal: vi.fn(),
  reap: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/exec.js", () => ({ runCommandBuffered: mocks.snapshot }));
vi.mock("../process/kill-tree.js", () => ({ signalProcessTree: mocks.signal }));
vi.mock("../process/scoped-child-reaper.js", () => ({
  scheduleAdoptedChildZombieReapAfterExit: mocks.reap,
}));

const fixture = useCanaryFixture(mocks);

describe("update candidate canary cleanup", () => {
  it("keeps verified readiness and records a warning when rehearsal cleanup fails", async () => {
    stubHealthyGateway();
    const inventoryRoot = fixture.tempDirs.make("canary-inventory-");
    let inventoryAllocated = false;
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
      const availableBytes = targetPath === inventoryRoot && inventoryAllocated ? 0 : 1024 ** 3;
      if (targetPath === inventoryRoot) {
        inventoryAllocated = true;
      }
      return { targetPath, checkedPath: targetPath, availableBytes, totalBytes: 1024 ** 3 };
    });
    const remove = fs.rm.bind(fs);
    let retained: string | undefined;
    let removedOther: string | undefined;
    const denial = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        path.basename(target).startsWith("openclaw-update-canary-")
      ) {
        if (!retained) {
          retained = target;
          throw new Error("synthetic cleanup permission denied");
        }
        await remove(target, options);
        removedOther = target;
        return;
      }
      return remove(target, options);
    });
    const onStep = vi.fn();
    try {
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: { TMPDIR: inventoryRoot },
        timeoutMs: 3000,
        onStep,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "candidate gateway canary", exitCode: 0 }),
      );
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "candidate rehearsal cleanup",
          advisory: expect.objectContaining({
            message: expect.stringContaining("synthetic cleanup permission denied"),
          }),
        }),
      );
      expect(onStep).toHaveBeenCalledWith(result.steps.at(-1));
      expect(result.steps.at(-1)?.advisory?.message).toContain(retained);
      expect(removedOther).toBeDefined();
      expect(removedOther).not.toBe(retained);
      await expect(fs.access(removedOther!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      denial.mockRestore();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  });

  it.each([
    { exitAfter: "TERM", callerOwned: false, windows: false, expired: false },
    { exitAfter: "KILL", callerOwned: false, windows: false, expired: false },
    { exitAfter: "survives", callerOwned: false, windows: false, expired: false },
    { exitAfter: "survives", callerOwned: true, windows: false, expired: false },
    { exitAfter: "EPERM", callerOwned: false, windows: false, expired: false },
    { exitAfter: "EPERM", callerOwned: true, windows: false, expired: false },
    { exitAfter: "survives", callerOwned: false, windows: true, expired: false },
    { exitAfter: "KILL", callerOwned: false, windows: false, expired: true },
    { exitAfter: "TERM", callerOwned: false, windows: true, expired: false },
  ] as const)(
    "confirms process cleanup ($exitAfter, callerOwned=$callerOwned, windows=$windows, expired=$expired)",
    async ({ exitAfter, callerOwned, windows, expired }) => {
      const actualNow = Date.now;
      let clockAdvance = 0;
      if (expired) {
        vi.spyOn(Date, "now").mockImplementation(() => actualNow() + clockAdvance);
      }
      let gatewayPid: number | undefined;
      let groupAlive = true;
      let statePresentAtExit = false;
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const probe = vi.fn((pid: number, signal: number) => {
        expect(signal).toBe(0);
        if (pid === Number(gatewayPid) * (windows ? 1 : -1) && groupAlive) {
          if (exitAfter === "EPERM") {
            throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
          }
          return true;
        }
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          gatewayPid = [...fixture.children.keys()].at(-1);
          if (expired && String(url).endsWith("/readyz")) {
            clockAdvance = 5_000;
          }
          return Response.json({ status: "started", ready: true });
        }),
      );
      mocks.signal.mockImplementation(
        (pid: number, signal: string, options: { onComplete?: () => void }) => {
          if (!windows) {
            fixture.children.get(pid)?.emit("close", 0);
          }
          options.onComplete?.();
          if (pid === gatewayPid && signal === `SIG${exitAfter}`) {
            exitTimer = setTimeout(() => {
              void fs.access(fixture.childEnv.OPENCLAW_STATE_DIR!).then(
                () => {
                  statePresentAtExit = true;
                  groupAlive = false;
                },
                () => {
                  groupAlive = false;
                },
              );
            }, 25);
          }
        },
      );
      const rehearsal = callerOwned
        ? await prepareUpdateCandidateRehearsal({
            candidateRoot: fixture.root,
            stateDir: fixture.root,
            config: {},
            env: {},
          })
        : undefined;
      try {
        const result = await validateUpdateCandidateCanary({
          root: fixture.root,
          stateDir: fixture.root,
          config: {},
          env: {},
          timeoutMs: 500,
          rehearsal,
          onStep: (step) => {
            if (step.name === "candidate snapshot") {
              // Prepare real directories on the host before simulating child-process semantics.
              vi.stubGlobal("process", {
                ...process,
                platform: windows ? "win32" : "linux",
                kill: probe,
              });
            }
          },
        });
        expect(gatewayPid, result.logTail.join("\n")).toBeDefined();
        if (exitAfter === "survives" || exitAfter === "EPERM") {
          expect(result).toMatchObject({ status: "error", phase: "readiness" });
          expect(result.logTail.join("\n")).toContain("process tree did not exit");
          expect(result.steps.some((step) => step.advisory)).toBe(false);
          if (rehearsal) {
            await expect(rehearsal.cleanup()).rejects.toBeInstanceOf(
              UpdateCandidateRehearsalInUseError,
            );
            const spawnCount = mocks.spawn.mock.calls.length;
            const retry = await validateUpdateCandidateCanary({
              root: fixture.root,
              stateDir: fixture.root,
              config: {},
              env: {},
              rehearsal,
            });
            expect(retry.status).toBe("error");
            expect(mocks.spawn).toHaveBeenCalledTimes(spawnCount);
          }
          await expect(fs.access(fixture.childEnv.OPENCLAW_STATE_DIR!)).resolves.toBeUndefined();
        } else {
          expect(result.status, result.logTail.join("\n")).toBe("ok");
          expect(groupAlive).toBe(false);
          expect(statePresentAtExit).toBe(true);
          await expect(fs.access(fixture.childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        expect(probe).toHaveBeenCalledWith(Number(gatewayPid) * (windows ? 1 : -1), 0);
        expect(
          mocks.signal.mock.calls.filter(([pid]) => pid === gatewayPid).map(([, signal]) => signal),
        ).toEqual(exitAfter === "TERM" && !windows ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
        if (!windows) {
          expect(mocks.reap).toHaveBeenCalledWith(fixture.children.get(Number(gatewayPid)), true);
        }
      } finally {
        clearTimeout(exitTimer);
        // No real child was launched; only the fixture may remove retained test state.
        await fs.rm(fixture.childEnv.OPENCLAW_STATE_DIR!, { recursive: true, force: true });
      }
    },
  );

  it("drains a cancelled validation child before deleting its private state", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const child = new FakeChild(fixture.nextPid++);
      fixture.children.set(child.pid, child);
      fixture.childEnv = options.env;
      queueMicrotask(() => controller.abort(new Error("repair deadline")));
      return child;
    });
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3_000,
      signal: controller.signal,
    });
    expect(result.status).toBe("error");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.signal.mock.calls.map(([, signal]) => signal)).toEqual(
      process.platform === "win32" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
    );
    await expect(fs.access(fixture.childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("aborts further validation and removes private state when recording a step fails", async () => {
    await expect(
      validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
        timeoutMs: 3_000,
        onStep: () => {
          throw new Error("ledger unavailable");
        },
      }),
    ).rejects.toThrow("ledger unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
    const snapshotInput = JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as {
      targetStateDir: string;
    };
    await expect(fs.access(snapshotInput.targetStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
