import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { assertReliabilityForcedExit } from "../../scripts/lib/sqlite-reliability-process.js";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
export const ACTIVATION_EVENT_PREFIX = "OPENCLAW_ACTIVATION_TEST ";
export const ACTIVATION_TIMEOUT_MS = 60_000;
export type ActivationFault = {
  label: string;
  operation: "rename" | "remove" | "unlink" | "rmdir" | "copy" | "symlink";
  path: string;
  argument?: 0 | 1;
  descendants?: boolean;
  basename?: string;
  postCore?: boolean;
  when: "before" | "after";
  occurrence?: number;
  action?: "error" | "observe";
};

type ProcessEvent = {
  event: string;
  pid: number;
  parentPid?: number;
  label?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  startIdentity?: number;
  detached?: boolean;
  fd3?: boolean;
  fenced?: boolean;
};

type ActivationProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export function activationEnvironment(base: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, "home"),
    TMPDIR: path.join(base, "tmp"),
    LC_ALL: "C",
    TZ: "UTC",
    OPENCLAW_STATE_DIR: path.join(base, "state"),
    OPENCLAW_CONFIG_PATH: path.join(base, "state", "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    npm_config_cache: path.join(base, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

// Each ancestor stays alive until explicitly killed. Its child exit event proves
// reaping before the next ancestor dies; the test process is never in this group.
const ancestorSource = `
const { spawn } = require("node:child_process");
const [encoded, source] = process.argv.slice(1);
const options = JSON.parse(encoded);
const args = options.depth > 1
  ? ["-e", source, JSON.stringify({ ...options, depth: options.depth - 1 }), source]
  : options.args;
const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
const emit = value => process.stdout.write("OPENCLAW_ACTIVATION_TEST " + JSON.stringify(value) + "\\n");
emit({ event: "spawned", pid: child.pid, parentPid: process.pid });
child.once("error", error => { throw error; });
child.once("exit", (code, signal) => emit({ event: "reaped", pid: child.pid, code, signal }));
setInterval(() => {}, 1000);
`;

export function startActivationProcess(params: {
  base: string;
  args: string[];
  preload?: string;
  faults?: ActivationFault[];
  ancestors?: boolean;
  observeChildren?: boolean;
  childFault?: "spawn" | "early-exit" | "closed-pipe";
  env?: NodeJS.ProcessEnv;
}) {
  const events: ProcessEvent[] = [];
  const changes = new EventEmitter();
  const identities = new Map<number, number>();
  let stdout = "";
  let stderr = "";
  const buffers = { stdout: "", stderr: "" };
  const groups = new Set<number>();
  if (params.faults?.length || params.observeChildren) {
    assert.ok(params.preload, "filesystem checkpoints require the source fixture preload");
  }
  const args = [
    ...(params.faults?.length || params.observeChildren ? ["--import", params.preload!] : []),
    ...params.args,
  ];
  const child = spawn(
    process.execPath,
    params.ancestors
      ? ["-e", ancestorSource, JSON.stringify({ args, depth: 2 }), ancestorSource]
      : args,
    {
      cwd: params.base,
      env: {
        ...activationEnvironment(params.base),
        ...params.env,
        ...(params.faults?.length
          ? { OPENCLAW_ACTIVATION_TEST_FAULTS: JSON.stringify(params.faults) }
          : {}),
        ...(params.observeChildren
          ? {
              NODE_OPTIONS: `--import ${JSON.stringify(params.preload)}`,
              OPENCLAW_ACTIVATION_TEST_OBSERVE_CHILDREN: "1",
              OPENCLAW_ACTIVATION_TEST_CHILD_FAULT: params.childFault,
            }
          : {}),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  function recordIdentity(pid: number, observed?: number) {
    const identity = observed ?? getFileLockProcessStartTime(pid);
    assert.notEqual(identity, null, `fixture process ${pid} has no start identity`);
    identities.set(pid, identity!);
  }
  assert.ok(child.pid, "fixture process did not spawn");
  recordIdentity(child.pid);
  groups.add(child.pid);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const consume = (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stdout") {
      stdout += chunk;
    } else {
      stderr += chunk;
    }
    buffers[stream] += chunk;
    let newline: number;
    while ((newline = buffers[stream].indexOf("\n")) >= 0) {
      const line = buffers[stream].slice(0, newline);
      buffers[stream] = buffers[stream].slice(newline + 1);
      if (!line.startsWith(ACTIVATION_EVENT_PREFIX)) {
        continue;
      }
      const event = JSON.parse(line.slice(ACTIVATION_EVENT_PREFIX.length)) as ProcessEvent;
      if (event.event === "spawned") {
        recordIdentity(event.pid, event.startIdentity);
        if (event.detached) {
          groups.add(event.pid);
        }
      }
      events.push(event);
      changes.emit("change");
    }
  };
  child.stdout.on("data", (chunk: string) => consume("stdout", chunk));
  child.stderr.on("data", (chunk: string) => consume("stderr", chunk));
  const rawClosed = new Promise<ActivationProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
      changes.emit("change");
    });
  });
  const closed = bounded(rawClosed, ACTIVATION_TIMEOUT_MS, "activation process/output close");
  void closed.catch(() => {});

  async function waitFor(
    predicate: (event: ProcessEvent) => boolean,
    description: string,
  ): Promise<ProcessEvent> {
    const found = events.find(predicate);
    if (found) {
      return found;
    }
    return await new Promise((resolve, reject) => {
      const stopWaiting = () => {
        clearTimeout(timeout);
        changes.off("change", check);
      };
      const check = () => {
        const event = events.find(predicate);
        if (event) {
          stopWaiting();
          resolve(event);
        } else if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          events.some(
            (entry) =>
              entry.event === "reaped" &&
              entry.code !== null &&
              !events.some(
                (spawned) =>
                  spawned.event === "spawned" &&
                  spawned.pid === entry.pid &&
                  spawned.fd3 !== undefined,
              ),
          )
        ) {
          stopWaiting();
          reject(new Error(`fixture closed before ${description}\n${stdout}\n${stderr}`));
        }
      };
      const timeout = setTimeout(() => {
        stopWaiting();
        reject(new Error(`timeout waiting for ${description}\n${stdout}\n${stderr}`));
      }, ACTIVATION_TIMEOUT_MS);
      changes.on("change", check);
      check();
    });
  }

  function killOwnedPid(pid: number) {
    assert.equal(
      getFileLockProcessStartTime(pid),
      identities.get(pid),
      `refusing to signal changed fixture process ${pid}`,
    );
    process.kill(pid, "SIGKILL");
  }

  async function killPid(pid: number) {
    if (!isPidAlive(pid)) {
      return;
    }
    killOwnedPid(pid);
    await waitForDead(pid, 5_000);
  }

  const group = (pid: number) => ({
    pid,
    exitCode: isPidAlive(pid) ? null : 1,
    signalCode: null,
  });
  async function joinProcesses() {
    await bounded(
      Promise.all([
        rawClosed,
        ...[...groups].map(async (pid) => {
          await waitForManagedProcessGroupExit(group(pid), 5_000, { errorPolicy: "indeterminate" });
          assert.equal(
            inspectManagedProcessGroup(group(pid), { errorPolicy: "indeterminate" }),
            "dead",
          );
        }),
      ]),
      6_000,
      "activation process, group, and output join",
    );
  }

  async function killAndJoin() {
    // Reverse spawn order preserves a live reaper for every killed descendant.
    for (const pid of [...identities.keys()].toReversed()) {
      if (!isPidAlive(pid)) {
        continue;
      }
      if (pid === child.pid) {
        killOwnedPid(pid);
        await waitForDead(pid, 5_000);
      } else {
        killOwnedPid(pid);
        const reaped = await waitFor(
          (event) => event.event === "reaped" && event.pid === pid,
          `fixture process ${pid} reap`,
        );
        assertReliabilityForcedExit(
          { code: reaped.code ?? null, signal: reaped.signal ?? null },
          "activation fixture worker",
        );
      }
      await waitForDead(pid, 5_000);
    }
    await joinProcesses();
    assertReliabilityForcedExit(await rawClosed, "activation fixture ancestor");
  }

  async function cleanup() {
    const errors: unknown[] = [];
    for (const pid of [...groups].toReversed()) {
      try {
        const state = inspectManagedProcessGroup(group(pid), { errorPolicy: "indeterminate" });
        if (state === "dead") {
          continue;
        }
        assert.equal(state, "live", "fixture process group ownership is unknown");
        if (isPidAlive(pid)) {
          assert.equal(getFileLockProcessStartTime(pid), identities.get(pid));
        }
        terminateManagedChild(
          { ...group(pid), kill: (signal) => process.kill(pid, signal) },
          "SIGKILL",
          { processGroupFallback: "never" },
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await joinProcesses();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, "Activation fixture cleanup remains pending");
    }
  }

  return {
    child,
    closed,
    cleanup,
    killAndJoin,
    killPid,
    joinProcesses,
    pids: () => [...identities.keys()],
    events: () => [...events],
    output: () => ({ stdout, stderr }),
    checkpoint: (label: string) =>
      waitFor((event) => event.event === "checkpoint" && event.label === label, label),
    event: (name: string) => waitFor((event) => event.event === name, name),
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
