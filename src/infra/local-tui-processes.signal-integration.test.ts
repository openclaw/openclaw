import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverLocalTuiProcesses,
  terminateLocalTuiProcesses,
  type LocalTuiProcess,
} from "./local-tui-processes.js";
import { resolveOpenClawInstallationId } from "./openclaw-installation-id.js";

const children = new Set<ChildProcess>();
const orphanPids = new Set<number>();

afterEach(async () => {
  await Promise.all(
    [...children].map(
      async (child) =>
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  children.clear();
  for (const pid of orphanPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  orphanPids.clear();
});

async function spawnIgnoringTui(targetRoot: string): Promise<LocalTuiProcess> {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000)"],
    {
      argv0: `openclaw-tui@${resolveOpenClawInstallationId(targetRoot)}`,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`fixture exited: ${code}/${signal}`)));
  });
  const discovery = discoverLocalTuiProcesses({ targetRoot });
  if (!discovery.ok) {
    throw new Error(discovery.error);
  }
  const found = discovery.processes.find((candidate) => candidate.pid === child.pid);
  if (!found) {
    throw new Error(`fixture ${child.pid} was not discovered`);
  }
  return found;
}

function recordingController(signals: Array<string | number>) {
  return {
    kill: (pid: number, signal: NodeJS.Signals | 0) => {
      signals.push(signal);
      return process.kill(pid, signal);
    },
  };
}

describe("local TUI signal authority", () => {
  it.runIf(process.platform !== "win32")(
    "does not discover or signal an orphan announcement aimed at another live process",
    async () => {
      const targetRoot = process.cwd();
      const target = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        argv0: "unrelated-runtime",
        stdio: "ignore",
      });
      children.add(target);
      if (!target.pid) {
        throw new Error("target fixture is missing its process id");
      }
      const targetPid = target.pid;
      const title = `openclaw-tui@${resolveOpenClawInstallationId(targetRoot)}#${targetPid}`;
      const launcher = spawn(
        process.execPath,
        [
          "-e",
          `const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{argv0:${JSON.stringify(title)},detached:true,stdio:"ignore"});process.stdout.write(String(c.pid));c.unref()`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const markerPid = await new Promise<number>((resolve, reject) => {
        let output = "";
        launcher.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        launcher.once("error", reject);
        launcher.once("exit", (code) => {
          const pid = Number(output);
          if (code === 0 && Number.isFinite(pid)) {
            resolve(pid);
          } else {
            reject(new Error(`orphan launcher exited ${code}: ${output}`));
          }
        });
      });
      orphanPids.add(markerPid);

      const discovery = discoverLocalTuiProcesses({ targetRoot });
      if (!discovery.ok) {
        throw new Error(discovery.error);
      }
      const signals: Array<string | number> = [];
      const advertisedTargets = discovery.processes.filter(
        (candidate) => candidate.pid === targetPid,
      );

      await expect(
        terminateLocalTuiProcesses({
          processes: advertisedTargets,
          targetRoot,
          controller: recordingController(signals),
          graceMs: 0,
          killGraceMs: 0,
        }),
      ).resolves.toEqual({ stopped: [], failed: [] });

      expect(advertisedTargets).toEqual([]);
      expect(signals).toEqual([]);
      expect(() => process.kill(targetPid, 0)).not.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not send the final signal after the discovered PID is reassigned",
    async () => {
      const targetRoot = process.cwd();
      const initial = await spawnIgnoringTui(targetRoot);
      const signals: Array<string | number> = [];
      const discover = vi
        .fn()
        .mockReturnValueOnce({ ok: true, processes: [initial] })
        .mockReturnValueOnce({
          ok: true,
          processes: [{ ...initial, startIdentity: `${initial.startIdentity}-reassigned` }],
        });

      await expect(
        terminateLocalTuiProcesses({
          processes: [initial],
          targetRoot,
          controller: recordingController(signals),
          discover,
          graceMs: 0,
          killGraceMs: 0,
        }),
      ).resolves.toEqual({ stopped: [], failed: [initial.pid] });

      expect(signals).toEqual([0, "SIGTERM", 0]);
      expect(() => process.kill(initial.pid, 0)).not.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not signal a process revalidated under a foreign account",
    async () => {
      const targetRoot = process.cwd();
      const initial = await spawnIgnoringTui(targetRoot);
      const signals: Array<string | number> = [];

      await expect(
        terminateLocalTuiProcesses({
          processes: [initial],
          targetRoot,
          controller: recordingController(signals),
          discover: () => ({
            ok: true,
            processes: [{ ...initial, ownership: "foreign-user" }],
          }),
          graceMs: 0,
          killGraceMs: 0,
        }),
      ).resolves.toEqual({ stopped: [], failed: [initial.pid] });

      expect(signals).toEqual([0]);
      expect(() => process.kill(initial.pid, 0)).not.toThrow();
    },
  );
});
