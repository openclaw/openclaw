import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import type { CommandProcessIdentity } from "./command-process-custody.types.js";
import { readCommandProcessFailure } from "./exec-result.js";
import { runCommandBuffersWithTimeout } from "./exec-runner.js";
import * as execSpawn from "./exec-spawn.js";

const unbufferedSpawn: {
  spawnCommandWithInvocation: typeof execSpawn.spawnCommandWithInvocation<{ buffer: false }>;
} = execSpawn;

afterEach(() => vi.restoreAllMocks());

function observeChild() {
  const ready = createDeferred();
  let child: ChildProcess | undefined;
  let output = "";
  const spawn = unbufferedSpawn.spawnCommandWithInvocation;
  vi.spyOn(unbufferedSpawn, "spawnCommandWithInvocation").mockImplementation((...args) => {
    const result = spawn(...args);
    child = result.child.nodeChildProcess;
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready\n")) {
        ready.resolve();
      }
    });
    return result;
  });
  return {
    ready: ready.promise,
    child: () => {
      if (!child) {
        throw new Error("Command did not spawn");
      }
      return child;
    },
    output: () => output,
    killRemainingFixture: () => {
      if (child?.pid && isChildProcessTreeAlive(child)) {
        process.kill(-child.pid, "SIGKILL"); // nosemgrep: security.opengrep.ghsa-jfv4-h8mc-jcp8.immediate-process-tree-sigkill -- Test-owned group; last-resort cleanup follows abort and settlement.
      }
    },
  };
}

describe.skipIf(process.platform !== "linux")("scoped command process identity", () => {
  it.for([false, true])(
    "prepares one asynchronous birth identity before guarded input (inherited custody: %s)",
    async (inheritedCustody, { signal }) => {
      const syncRead = vi.spyOn(fs, "readFileSync");
      const asyncRead = vi.spyOn(fsp, "readFile");
      const spawned = vi.fn<(identity: CommandProcessIdentity) => void>();
      const settled = vi.fn();
      let admittedPid: number | undefined;
      const command = () =>
        runCommandBuffersWithTimeout(
          [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
          {
            input: "owned input",
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            beforeInput: (pid) => {
              admittedPid = pid;
              if (inheritedCustody) {
                expect(spawned).toHaveBeenCalledWith({ pid, startedAt: expect.any(Number) });
              }
            },
          },
        );
      const result = await withinTest(
        execSpawn.withCommandProcessScope(
          inheritedCustody ? () => execSpawn.withCommandProcessScope(command) : command,
          signal,
          inheritedCustody ? { reserve: () => ({ spawned, settled }) } : undefined,
        ),
        signal,
      );
      expect(result).toMatchObject({ code: 0, termination: "exit", cleanup: "normal" });
      expect(result.stdout.toString()).toBe("owned input");
      expect(admittedPid).toBe(result.pid);
      const statPath = `/proc/${result.pid}/stat`;
      expect(syncRead.mock.calls.filter(([file]) => file === statPath)).toHaveLength(0);
      expect(asyncRead.mock.calls.filter(([file]) => file === statPath)).toHaveLength(1);
      if (inheritedCustody) {
        expect(settled).toHaveBeenCalledOnce();
      }
    },
  );

  it.for(["revoked", "cancelled", "exited", "custody-error"] as const)(
    "retains identity preparation and physical cleanup when %s",
    async (kind, { signal }) => {
      const syncRead = vi.spyOn(fs, "readFileSync");
      const entered = createDeferred();
      const resume = createDeferred();
      const observed = observeChild();
      const abort = new AbortController();
      const readFile = fsp.readFile;
      let held = false;
      vi.spyOn(fsp, "readFile").mockImplementation(async (file, options) => {
        const value = await readFile(file, options);
        if (held || typeof file !== "string" || !/^\/proc\/\d+\/stat$/.test(file)) {
          return value;
        }
        held = true;
        entered.resolve();
        await resume.promise;
        if (kind !== "exited" || typeof value !== "string") {
          return value;
        }
        // A delayed lookup can describe a successor after the owned child has exited.
        const end = value.lastIndexOf(")");
        const fields = value
          .slice(end + 2)
          .trim()
          .split(/\s+/);
        fields[19] = String(Number(fields[19]) + 1);
        return `${value.slice(0, end + 2)}${fields.join(" ")}`;
      });
      let active = true;
      const beforeInput = vi.fn(() => {
        if (!active) {
          throw new Error("input authority retired");
        }
      });
      const spawned = vi.fn<(identity: CommandProcessIdentity) => void>(() => {
        if (kind === "custody-error") {
          throw new Error("custody receipt unavailable");
        }
      });
      const settled = vi.fn();
      const released = vi.fn();
      const descendant =
        "process.on('SIGTERM',()=>{});process.stdin.resume();process.stdout.write('ready\\n')";
      const script = [
        "process.on('SIGUSR2',()=>process.exit(0))",
        "process.stdin.on('data',()=>{process.stdout.write('input\\n');process.exit(0)})",
        // Keep the unguarded fixture alive after its empty stdin reaches EOF; this does no polling.
        ...(kind === "exited" ? ["setInterval(()=>{},60000)"] : []),
        kind === "custody-error"
          ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['inherit','inherit','inherit']})`
          : "process.stdout.write('ready\\n')",
      ].join(";");
      const work = execSpawn
        .withCommandProcessScope(
          () =>
            runCommandBuffersWithTimeout([process.execPath, "-e", script], {
              ...(kind === "exited" ? { input: "" } : { input: "withheld", beforeInput }),
              killProcessTree: true,
              requireProcessTreeExtinction: true,
            }),
          abort.signal,
          { reserve: () => ({ spawned, settled }) },
        )
        .finally(released)
        .catch((error: unknown) => error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            Promise.all([entered.promise, observed.ready]),
            work,
            "Command settled without asynchronous identity preparation",
          ),
          signal,
        );
        expect(beforeInput).not.toHaveBeenCalled();
        expect(observed.output()).not.toContain("input\n");
        const child = observed.child();
        if (kind === "revoked") {
          active = false;
        } else {
          const exited = once(child, "exit");
          if (kind === "cancelled") {
            abort.abort(new Error("command cancelled"));
          } else {
            child.kill("SIGUSR2");
          }
          await withinTest(exited, signal);
          await nextEventLoopTurn();
          expect(released).not.toHaveBeenCalled();
          expect(settled).not.toHaveBeenCalled();
          if (kind === "custody-error") {
            expect(isChildProcessTreeAlive(child)).toBe(true);
          }
        }
        resume.resolve();
        const outcome = await withinTest(work, signal);
        if (kind === "exited") {
          expect(outcome).toMatchObject({ code: 0, termination: "exit", cleanup: "normal" });
          expect(spawned).toHaveBeenCalledWith({ pid: child.pid, startedAt: null });
        } else if (kind === "revoked") {
          expect(outcome).toBeInstanceOf(Error);
          expect(beforeInput).toHaveBeenCalledOnce();
          expect(readCommandProcessFailure(outcome)?.inputReleased).toBe(false);
        } else {
          expect(beforeInput).not.toHaveBeenCalled();
          if (kind === "custody-error") {
            expect(outcome).toBeInstanceOf(Error);
            expect(spawned).toHaveBeenCalledOnce();
          } else {
            expect(outcome).toMatchObject({ termination: "signal" });
          }
        }
        expect(observed.output()).not.toContain("input\n");
        expect(isChildProcessTreeAlive(child)).toBe(false);
        expect(
          syncRead.mock.calls.filter(([file]) => file === `/proc/${child.pid}/stat`),
        ).toHaveLength(0);
        expect(settled).toHaveBeenCalledOnce();
        expect(released).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        abort.abort();
        try {
          await withinTest(work, signal);
        } finally {
          observed.killRemainingFixture();
        }
      }
    },
  );
});
