import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import * as execSpawn from "./exec-spawn.js";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "linux").for([false, true])(
  "native cancellation joins async identity without sync procfs (held read: %s)",
  async (holdRead, { signal }) => {
    const release = createDeferredCore();
    const reading = createDeferredCore();
    const ready = createDeferredCore();
    const terminated = createDeferredCore();
    const readFile = fsPromises.readFile.bind(fsPromises);
    let held = false;
    vi.spyOn(fsPromises, "readFile").mockImplementation((file, options) => {
      const result = readFile(file, options);
      if (holdRead && !held && typeof file === "string" && /^\/proc\/\d+\/stat$/.test(file)) {
        held = true;
        return result.then(async (stat) => {
          reading.resolve();
          await release.promise;
          return stat;
        });
      }
      return result;
    });
    const syncReads = vi.spyOn(fs, "readFileSync");
    const syncDirectories = vi.spyOn(fs, "readdirSync");
    const spawn = execSpawn.spawnCommandWithInvocation;
    let child: ChildProcess | undefined;
    let observed = "";
    vi.spyOn(execSpawn, "spawnCommandWithInvocation").mockImplementation((...args) => {
      const spawned = spawn(...args);
      child = spawned.child.nodeChildProcess;
      child.stdout!.on("data", (chunk: Buffer) => {
        observed += chunk.toString();
        if (observed.includes("ready\n")) {
          ready.resolve();
        }
        if (observed.includes("term\n")) {
          terminated.resolve();
        }
      });
      return spawned;
    });
    const controller = new AbortController();
    const finished = vi.fn();
    const work = runCommandWithTimeout(
      [
        requireNodeTool("node"),
        "-e",
        "process.on('SIGTERM',()=>process.stdout.write('term\\n'));process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ],
      { signal: controller.signal, killProcessTree: true, killGraceMs: 0, timeoutMs: 5_000 },
    ).finally(finished);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([...(holdRead ? [reading.promise] : []), ready.promise]),
          work,
          "native child did not reach cancellation readiness",
        ),
        signal,
      );
      controller.abort();
      if (holdRead) {
        await withinTest(
          awaitGateBeforeSettlement(terminated.promise, work, "TERM did not reach the live child"),
          signal,
        );
        await nextTurn();
        expect(finished).not.toHaveBeenCalled();
        release.resolve();
      }
      const result = await withinTest(work, signal);
      expect(result).toMatchObject({ termination: "signal", cleanup: "forced" });
      expect(result.stdout).toContain("ready\n");
      if (holdRead) {
        expect(result.stdout).toContain("term\n");
      }
      expect(syncReads.mock.calls.filter(([file]) => String(file).startsWith("/proc/"))).toEqual(
        [],
      );
      expect(
        syncDirectories.mock.calls.filter(([file]) => String(file).startsWith("/proc")),
      ).toEqual([]);
      expect(isPidAlive(child!.pid!)).toBe(false);
    } finally {
      release.resolve();
      controller.abort();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await work.catch(() => {});
    }
  },
);
