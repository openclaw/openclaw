import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  hasUnjoinedWork,
  runManagedCommand,
  signalExitCode,
} from "../../scripts/lib/managed-child-process.mts";
import { hasSemanticTestBackend } from "./native-boundary-fixture.js";

const available = process.platform === "linux" && hasSemanticTestBackend();

it.runIf(available)(
  "contains aggregate native allocations and joins the whole cgroup after OOM",
  async ({ signal }) => {
    let memoryScope = "";
    // Keep the buffers reachable until the kernel ends the workload.
    const allocate =
      "const a=globalThis.allocations=[];for(let i=0;i<16;i++)a.push(Buffer.alloc(8*1024**2,1));setInterval(()=>{},1000)";
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          "for(let i=0;i<2;i++)spawn(process.execPath,['-e'," +
            JSON.stringify(allocate) +
            "],{stdio:'inherit'});",
          "setInterval(()=>{},1000);",
        ].join("\n"),
      ],
      memoryLimitBytes: 256 * 1024 ** 2,
      onMemoryScope(unit) {
        memoryScope = unit;
      },
      timeoutMs: 15_000,
      requireProcessTreeExit: true,
      signal,
    });
    expect(code).toBe(137);
    const state = spawnSync("systemctl", ["--user", "show", "--property=LoadState", memoryScope], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(state.stdout).toContain("LoadState=not-found");
  },
  25_000,
);

it.runIf(available).for([false, true])(
  "returns the workload result through a verified bounded launcher (shell: %s)",
  { timeout: 20_000 },
  async (shell, { signal }) => {
    let output = "";
    const code = await runManagedCommand({
      bin: shell ? "printf 'bounded\\n'; exit 7" : process.execPath,
      args: shell ? [] : ["-e", "process.stdin.pipe(process.stdout);process.exitCode=7;"],
      shell,
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 10_000,
      requireProcessTreeExit: true,
      signal,
      stdio: shell ? ["ignore", "pipe", "pipe"] : "pipe",
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stdin?.end("bounded\n");
      },
    });
    expect(code).toBe(7);
    expect(output).toBe("bounded\n");
  },
);

it.runIf(available).for(["SIGPIPE", "SIGUSR1"] as const)(
  "preserves native %s exit status through Node's special signal disposition",
  { timeout: 15_000 },
  async (signal, { signal: abortSignal }) => {
    let exitSignal: NodeJS.Signals | null | undefined;
    const code = await runManagedCommand({
      bin: "/bin/sh",
      args: ["-c", `kill -${signal.slice(3)} $$`],
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 10_000,
      signal: abortSignal,
      stdio: "ignore",
      onReady(child) {
        child.once("exit", (_code, received) => {
          exitSignal = received;
        });
      },
    });
    expect(code).toBe(signalExitCode(signal));
    expect(exitSignal).toBe(signal);
  },
);

it.runIf(available)(
  "keeps one cancellation signal and the caller's longer cleanup grace",
  async ({ signal }) => {
    const abort = new AbortController();
    let output = "";
    const result = runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        [
          "let signals=0;process.on('SIGTERM',()=>{",
          "if(++signals>1)process.exit(9);process.stdout.write('term\\n');",
          // This must exceed the removed launcher's independent five-second timer.
          "setTimeout(()=>process.stdout.write('drained\\n',()=>process.exit(0)),5500)});",
          "setInterval(()=>{},1000);console.log('ready');",
        ].join("\n"),
      ],
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 15_000,
      abortKillGraceMs: 7_000,
      signal: AbortSignal.any([signal, abort.signal]),
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("ready\n")) {
            abort.abort();
          }
        });
      },
    });
    await expect(result).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(output).toBe("ready\nterm\ndrained\n");
  },
  20_000,
);

it.runIf(available)(
  "joins a detached pipe holder with default cleanup options and no deadline",
  async ({ signal }) => {
    let memoryScope = "";
    let failure: unknown;
    let status: number | undefined;
    try {
      status = await runManagedCommand({
        bin: process.execPath,
        args: [
          "-e",
          [
            "const leaf=\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');process.disconnect()\";",
            "const child=require('node:child_process').spawn(process.execPath,['-e',leaf],{detached:true,stdio:['ignore','inherit','inherit','ipc']});",
            "child.once('message',()=>process.exit(0));",
          ].join("\n"),
        ],
        memoryLimitBytes: 256 * 1024 ** 2,
        onMemoryScope(unit) {
          memoryScope = unit;
        },
        signal,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure !== undefined || (status !== undefined && status !== 0)).toBe(true);
    expect(hasUnjoinedWork(failure)).toBe(false);
    const state = spawnSync("systemctl", ["--user", "show", "--property=LoadState", memoryScope], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(state.stdout).toContain("LoadState=not-found");
  },
  30_000,
);

it.runIf(available)(
  "preserves a workload signal exit so surviving descendants drain gracefully",
  async ({ signal }) => {
    let output = "";
    let exitSignal: NodeJS.Signals | null | undefined;
    const leaf =
      "process.on('SIGTERM',()=>process.stdout.write('drained\\n',()=>process.exit(0)));setInterval(()=>{},1000);process.send('ready');process.disconnect()";
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        [
          "const child=require('node:child_process').spawn(process.execPath,['-e'," +
            JSON.stringify(leaf) +
            "],{stdio:['ignore','inherit','inherit','ipc']});",
          "child.once('message',()=>process.kill(process.pid,'SIGTERM'));",
        ].join("\n"),
      ],
      memoryLimitBytes: 256 * 1024 ** 2,
      timeoutMs: 10_000,
      requireProcessTreeExit: true,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
        });
        child.once("exit", (_code, received) => {
          exitSignal = received;
        });
      },
    });
    expect(code).toBe(143);
    expect(exitSignal).toBe("SIGTERM");
    expect(output).toBe("drained\n");
  },
  20_000,
);
