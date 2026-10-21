import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDistArtifactLockPath } from "../../scripts/lib/dist-artifact-lock.mts";
import * as managedChildProcess from "../../scripts/lib/managed-child-process.mts";
import * as processMemory from "../../scripts/lib/process-memory.mts";
import {
  createPrefixedOutputWriter,
  parseMode,
  resolveBoundaryRootShimsTimeoutMs,
  resolveDeclarationCompilerEnv,
  runNodeStep as runNodeStepImpl,
  runNodeSteps as runNodeStepsImpl,
  runNodeStepsInParallel as runNodeStepsInParallelImpl,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import { writeNativeFixtureFile } from "./native-boundary-fixture.js";

const fixture = createFixtureLifetime();
const { createTempDir } = fixture;
afterEach(() => fixture.cleanup());

const runNodeStep = (...args: Parameters<typeof runNodeStepImpl>) =>
  fixture.track(runNodeStepImpl(...args));
const runNodeSteps = (...args: Parameters<typeof runNodeStepsImpl>) =>
  fixture.track(runNodeStepsImpl(...args));
const runNodeStepsInParallel = (...args: Parameters<typeof runNodeStepsInParallelImpl>) =>
  fixture.track(runNodeStepsInParallelImpl(...args));

function observeFixtureLine(expected: string) {
  const gate = createDeferred();
  return {
    promise: gate.promise,
    onStdoutLine: (line: string) => {
      if (line.trim() === expected) {
        gate.resolve();
        return false;
      }
      return true;
    },
  };
}

const readPid = (file: string) => Number(fs.readFileSync(file, "utf8"));
async function rescueDescendant(file: string, signal: AbortSignal, fallback = 0) {
  const pid = fs.existsSync(file) ? readPid(file) : fallback;
  if (pid && isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForDead(pid, signal);
  }
  return pid;
}

function spawnDescendant(script: string, onTerm = "") {
  return [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ["--eval", ${JSON.stringify(script)}], { stdio: "inherit" });`,
    onTerm,
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

function failOnFile(file: string) {
  return {
    label: "delayed-fail",
    args: [
      "--eval",
      `const fs = require('node:fs');
setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) process.exit(2); }, 25);`,
    ],
    timeoutMs: 30_000,
  };
}

function waitForReady<T>(
  ready: Promise<T>,
  outcome: Promise<unknown>,
  file: string,
  signal: AbortSignal,
) {
  return withinTest(
    awaitGateBeforeSettlement(ready, outcome, `Timed out waiting for ${file}`),
    signal,
  );
}

// Keep the real CLI and owned entry intact; intercept only generator checkpoints
// and the terminal compiler workload. Retry executes the real native compiler.
function createPreparationCli(workload = "", preparationCheckpoint = "") {
  const root = fs.realpathSync.native(createTempDir("openclaw-preparation-cli-"));
  const write = (relative: string, content: string | object) =>
    writeNativeFixtureFile(
      root,
      relative,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  const wrapScript = (name: string, content: string) => {
    fs.renameSync(
      path.join(root, `scripts/${name}.mts`),
      path.join(root, `scripts/${name}.actual.mts`),
    );
    write(`scripts/${name}.mts`, content);
  };
  fs.mkdirSync(path.join(root, ".git"));
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("pnpm-workspace.yaml", "packages: []\n");
  write("src/plugin-sdk/qa-channel-protocol.ts", "export const value = 1;\n");
  write("tsconfig.json", {
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      lib: ["es5"],
      types: [],
      skipLibCheck: true,
    },
  });
  write("packages/plugin-sdk/tsconfig.json", {
    extends: "../../tsconfig.json",
    include: ["../../src/plugin-sdk/**/*.ts"],
  });
  installDistArtifactScripts(
    root,
    [
      "prepare-extension-package-boundary-artifacts.mts",
      "compile-extension-boundary.mts",
      "run-tsgo.mts",
      "run-tsgo.mjs",
    ],
    { dependencies: ["tsx", "@openclaw/fs-safe", "@openclaw/proc-safe"] },
  );
  write("src/shared/deferred.ts", fs.readFileSync("src/shared/deferred.ts", "utf8"));
  wrapScript(
    "generate-kysely-types",
    `
import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { ensureKyselyTypes as ensure } from "./generate-kysely-types.actual.mts";
export async function ensureKyselyTypes(...args) {
  fs.writeFileSync(new URL("../preparation.pid", import.meta.url), String(process.pid));
  await ensure(...args);
  ${preparationCheckpoint}
}
`,
  );
  wrapScript(
    "compile-extension-boundary",
    `
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.writeFileSync(new URL("../compiler-started", import.meta.url), String(process.pid));
${workload}
await import("./compile-extension-boundary.actual.mts");
`,
  );
  // Model only the enclosing updater owner; the actual entry owns cancellation.
  write(
    "owner.mts",
    `
import path from "node:path";
import { withDistArtifactOwnership, distArtifactEntryArgs } from "./scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "./scripts/lib/managed-child-process.mts";
process.exitCode = await withDistArtifactOwnership(process.cwd(), () => runManagedCommand({
  bin: process.execPath,
  args: distArtifactEntryArgs(path.resolve("scripts/prepare-extension-package-boundary-artifacts.mts"), ["--mode=package-boundary"]),
  cwd: process.cwd(), stdio: "inherit", requireProcessTreeExit: true,
}));
`,
  );
  const processes: Array<{ child: ReturnType<typeof spawn>; closed: Promise<unknown> }> = [];
  const start = () => {
    const child = spawn(resolveTestNodeExecPath(), ["--import", "./scripts/tsx.mjs", "owner.mts"], {
      cwd: root,
      env: { ...process.env, OPENCLAW_ALLOW_LIVE_DIST_BUILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    const closed = fixture.track(once(child, "close"));
    processes.push({ child, closed });
    return { child, closed, output: () => output };
  };
  const claims = () => fs.readdirSync(resolveDistArtifactLockPath(root));
  const recordPath = path.join(root, ".artifacts/extension-package-boundary/plugin-sdk.json");
  const declarationPath = path.join(
    root,
    "packages/plugin-sdk/dist/src/plugin-sdk/qa-channel-protocol.d.ts",
  );
  const cleanup = async () => {
    for (const { child } of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
    await Promise.all(processes.map(({ closed }) => closed));
  };
  const retry = async (signal: AbortSignal) => {
    write("retry", "");
    const runner = start();
    expect(await withinTest(runner.closed, signal), runner.output()).toEqual([0, null]);
    expect(fs.readFileSync(declarationPath, "utf8")).toContain("value = 1");
    expect(fs.existsSync(recordPath)).toBe(true);
  };
  const cancel = (signal: NodeJS.Signals) =>
    process.kill(readPid(path.join(root, "preparation.pid")), signal);
  return { root, write, start, cleanup, retry, cancel, claims, recordPath, declarationPath };
}

describe("prepare-extension-package-boundary-artifacts", () => {
  it("prefixes each completed line and flushes the trailing partial line", () => {
    let output = "";
    const writer = createPrefixedOutputWriter("boundary", {
      write(chunk: string) {
        output += chunk;
      },
    });

    writer.write("first line\nsecond");
    writer.write(" line\nthird");
    writer.flush();

    expect(output).toBe("[boundary] first line\n[boundary] second line\n[boundary] third");
  });

  it.runIf(process.platform !== "win32")(
    "lets aborted sibling descendants drain during kill grace",
    ({ signal }) =>
      fixture.run(async () => {
        const root = createTempDir("openclaw-boundary-abort-drain-");
        const readyPath = path.join(root, "descendant.ready");
        const drainedPath = path.join(root, "descendant.drained");
        const failPath = path.join(root, "fail");
        const ready = observeFixtureLine("ready");
        const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(drainedPath)}, "drained");
    process.exit(0);
  }, 50);
});
fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
        const command = runNodeStepsInParallel([
          failOnFile(failPath),
          {
            label: "abort-group-drain",
            args: [
              "--eval",
              spawnDescendant(descendant, "process.on('SIGTERM', () => process.exit(0));"),
            ],
            abortKillGraceMs: 100,
            timeoutMs: 60_000,
            onStdoutLine: ready.onStdoutLine,
          },
        ]);
        const outcome = command.catch((error: unknown) => error);
        const clock = vi.spyOn(Date, "now");
        const restoreClock = () => clock.mockRestore();
        signal.addEventListener("abort", restoreClock, { once: true });
        let pid = 0;
        try {
          await waitForReady(ready.promise, outcome, readyPath, signal);
          pid = readPid(readyPath);
          // Freeze only supervisor escalation; the child's cleanup timer remains real.
          clock.mockReturnValue(Date.now());
          fs.writeFileSync(failPath, "fail");
          await withinTest(outcome, signal);
          expect(fs.readFileSync(drainedPath, "utf8")).toBe("drained");
          expect(isProcessAlive(pid)).toBe(false);
          await expect(command).rejects.toThrow("delayed-fail failed with exit code 2");
        } finally {
          clock.mockRestore();
          signal.removeEventListener("abort", restoreClock);
          await fixture.verifyCleanup(async () => {
            try {
              fs.writeFileSync(failPath, "fail");
            } finally {
              await outcome;
              await rescueDescendant(readyPath, signal, pid);
            }
          });
        }
      }),
  );

  it("clamps oversized prep step timers before scheduling", () =>
    fixture.run(async () => {
      await expect(
        runNodeStep(
          "slow-success",
          ["--eval", "setTimeout(() => process.exit(0), 25);"],
          MAX_TIMER_TIMEOUT_MS + 1,
        ),
      ).resolves.toBeUndefined();
    }));

  it.runIf(process.platform !== "win32").for(["SIGINT", "SIGTERM"] as const)(
    "preparation CLI joins detached groups and releases ownership after %s",
    (termination, { signal }) =>
      fixture.run(async () => {
        const descendantScript = `
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
require("node:fs").writeFileSync("descendant.pid", String(process.pid));
setInterval(() => {}, 1000);
process.stdout.write("ready\\n");
`;
        const f = createPreparationCli(`
if (!fs.existsSync("retry")) {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
`);
        const runner = f.start();
        const ready = observeFixtureLine("[plugin-sdk boundary dts] ready");
        const output = createInterface({ input: runner.child.stdout });
        output.on("line", ready.onStdoutLine);
        let descendantPid = 0;
        try {
          await waitForReady(ready.promise, runner.closed, "compiler checkpoint", signal);
          descendantPid = readPid(path.join(f.root, "descendant.pid"));
          expect(f.claims()).toContain("owner.json");
          expect(f.claims().filter((name) => name.startsWith("child-"))).toHaveLength(1);
          f.cancel(termination);
          expect(await withinTest(runner.closed, signal), runner.output()).toEqual([
            termination === "SIGINT" ? 130 : 143,
            null,
          ]);
          expect(isProcessAlive(descendantPid)).toBe(false);
          expect(f.claims(), "Joined cancellation must release owner and inherited claim").toEqual(
            [],
          );
          expect(fs.existsSync(f.recordPath)).toBe(false);
          await f.retry(signal);
          expect(f.claims()).toEqual([]);
        } finally {
          await fixture.verifyCleanup(async () => {
            await f.cleanup();
            output.close();
            await rescueDescendant(path.join(f.root, "descendant.pid"), signal, descendantPid);
          });
        }
      }),
  );

  it.runIf(process.platform !== "win32")(
    "preparation CLI cancels the asynchronous pre-compiler gap without admission or publication",
    ({ signal }) =>
      fixture.run(async () => {
        const connected = createDeferred<{ socket: net.Socket; ready: Promise<unknown[]> }>();
        const server = net.createServer((socket) =>
          connected.resolve({ socket, ready: once(socket, "data") }),
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing checkpoint port");
        }
        const f = createPreparationCli(
          "",
          `
if (!fs.existsSync("retry")) {
  const socket = net.connect(${address.port}, "127.0.0.1");
  await once(socket, "connect");
  // A next-turn acknowledgment lets the real command owner's abort microtask run
  // before the test releases this terminal generator checkpoint.
  process.once("SIGTERM", () => setImmediate(() => socket.write("observed")));
  const released = once(socket, "data");
  socket.write("ready");
  await released;
  socket.end();
}
`,
        );
        const runner = f.start();
        let socket: net.Socket | undefined;
        try {
          const checkpoint = await waitForReady(
            connected.promise,
            runner.closed,
            "generator checkpoint",
            signal,
          );
          socket = checkpoint.socket;
          await withinTest(checkpoint.ready, signal);
          const observed = once(socket, "data");
          expect(f.claims()).toContain("owner.json");
          expect(fs.existsSync(path.join(f.root, "compiler-started"))).toBe(false);
          f.cancel("SIGTERM");
          await withinTest(observed, signal);
          socket.write("continue");
          expect(await withinTest(runner.closed, signal), runner.output()).toEqual([143, null]);
          expect(
            fs.existsSync(path.join(f.root, "compiler-started")),
            "Canceled preparation must not admit a compiler",
          ).toBe(false);
          expect(fs.existsSync(f.declarationPath)).toBe(false);
          expect(fs.existsSync(f.recordPath)).toBe(false);
          expect(f.claims()).toEqual([]);
          await f.retry(signal);
        } finally {
          await fixture.verifyCleanup(async () => {
            socket?.end("continue");
            await f.cleanup();
            socket?.destroy();
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          });
        }
      }),
  );

  it.for(["sibling", "command"] as const)("does not admit work after %s cancellation", (origin) =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-canceled-");
      const startedPath = path.join(rootDir, "started");
      const abortController = new AbortController();
      abortController.abort();
      await expect(
        runNodeStep(
          "late-prep",
          ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started")`],
          1_000,
          origin === "sibling" ? { abortController } : { signal: abortController.signal },
        ),
      ).rejects.toThrow(origin === "sibling" ? "canceled before starting" : "aborted");
      expect(fs.existsSync(startedPath)).toBe(false);
    }),
  );

  it.each([
    { cpus: 8, memoryGiB: 24, local: undefined, expected: 2 },
    { cpus: 8, memoryGiB: null, local: undefined, expected: 1 },
    { cpus: 8, memoryGiB: 24, local: "1", expected: 1 },
  ])(
    "bounds CI declaration children to $expected ($cpus CPUs, $memoryGiB GiB, local=$local)",
    async ({ cpus, memoryGiB, local, expected }) => {
      const children = Array.from({ length: 4 }, () => ({
        started: createDeferred(),
        finished: createDeferred<number>(),
      }));
      const commands: string[] = [];
      const capacityBytes = memoryGiB === null ? null : memoryGiB * 1024 ** 3;
      vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
      vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 ** 3);
      vi.spyOn(processMemory, "readProcessMemoryCapacity").mockReturnValue({
        capacityBytes,
        limitBytes: capacityBytes,
        availableBytes: capacityBytes,
        unresolved: memoryGiB === null,
        usageKnown: false,
      });
      vi.spyOn(managedChildProcess, "runManagedCommand").mockImplementation(({ args }) => {
        const index = args?.[0];
        if (index === undefined) {
          throw new Error("Missing compiler fixture ID");
        }
        commands.push(index);
        const child = children[Number(index)]!;
        child.started.resolve();
        return child.finished.promise;
      });
      const count = process.platform === "linux" ? expected : 1;
      const running = runNodeSteps(
        children.map((_, index) => ({
          label: String(index),
          args: [String(index)],
          timeoutMs: 5_000,
        })),
        { CI: "true", OPENCLAW_LOCAL_CHECK: local },
      );
      try {
        for (let offset = 0; offset < children.length; offset += count) {
          await children[offset]!.started.promise;
          expect(commands).toEqual(
            Array.from({ length: offset + count }, (_, index) => String(index)),
          );
          for (const child of children.slice(offset, offset + count)) {
            child.finished.resolve(0);
          }
        }
        await running;
      } finally {
        for (const child of children) {
          child.finished.resolve(0);
        }
        await running;
        vi.restoreAllMocks();
      }
    },
  );

  it("parses prep mode and rejects unknown values", () => {
    expect(parseMode([])).toBe("all");
    expect(parseMode(["--mode=package-boundary"])).toBe("package-boundary");
    expect(() => parseMode(["--mode=nope"])).toThrow("Unknown mode: nope");
  });

  it("sizes serial CI declaration compilers to the constrained runner", () => {
    const gib = 1024 ** 3;
    const host = { logicalCpuCount: 4, totalMemoryBytes: 15 * gib, memoryCapacityBytes: 15 * gib };
    const expected = {
      GOMAXPROCS: "4",
      GOGC: "100",
      GOMEMLIMIT: "11520MiB",
    };
    expect(resolveDeclarationCompilerEnv({ CI: "true" }, host)).toMatchObject(expected);
    expect(resolveDeclarationCompilerEnv({ CI: "true", GOMAXPROCS: "3" }, host)).toMatchObject({
      ...expected,
      GOMAXPROCS: "3",
    });
    // Unknown cgroup ownership keeps the conservative constrained-runner limits.
    expect(
      resolveDeclarationCompilerEnv({ CI: "true" }, { ...host, memoryCapacityBytes: null }),
    ).toMatchObject({ GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" });
  });

  it("gives cold root shim generation macOS runner headroom", () => {
    const timeout = (value: string) =>
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: value,
      });
    expect(resolveBoundaryRootShimsTimeoutMs({})).toBe(300_000);
    expect(timeout("450000")).toBe(450_000);
    for (const value of ["120s", "0"]) {
      expect(() => timeout(value)).toThrow(
        "OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS must be a positive integer",
      );
    }
  });
});
