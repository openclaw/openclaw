import fs from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import { createDeferred } from "../helpers/promise.js";
import {
  RUNTIME_POSTBUILD_STAMP,
  createCurrentGitSpawnRecorder,
  createFakeProcess,
  it,
  runNodeCommand,
  setupStampedProject,
} from "./run-node.test-support.js";

it.for([
  { signal: "SIGINT", exitCode: 130 },
  { signal: "SIGTERM", exitCode: 143 },
  { signal: "SIGHUP", exitCode: 129 },
] as const)(
  "joins runtime postbuild after $signal without stamping or launching the CLI",
  async ({ signal, exitCode }, { tmp }) => {
    await setupStampedProject(tmp, { trackConfig: true });
    const fakeProcess = createFakeProcess();
    const { spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const cli = vi.fn(spawn);
    const started = createDeferred();
    const resume = createDeferred();
    const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
    let joined = false;
    const attempt = runNodeCommand(tmp, {
      process: fakeProcess,
      spawn: cli,
      spawnSync,
      env: { OPENCLAW_FORCE_RUNTIME_POSTBUILD: "1" },
      runRuntimePostBuild: async () => {
        started.resolve();
        await resume.promise;
        joined = true;
      },
    });
    let lockHeldAfterSignal = false;
    try {
      await Promise.race([started.promise, attempt]);
      fakeProcess.emit(signal);
      lockHeldAfterSignal = fs.existsSync(lockDir);
    } finally {
      resume.resolve();
      await attempt;
    }
    expect({
      exitCode: await attempt,
      cliLaunches: cli.mock.calls.length,
      joined,
      lockHeldAfterSignal,
      lockReleased: !fs.existsSync(lockDir),
      stamped: fs.existsSync(path.join(tmp, RUNTIME_POSTBUILD_STAMP)),
      remainingListeners: fakeProcess.listenerCount(signal),
    }).toEqual({
      exitCode,
      cliLaunches: 0,
      joined: true,
      lockHeldAfterSignal: true,
      lockReleased: true,
      stamped: false,
      remainingListeners: 0,
    });
  },
);
