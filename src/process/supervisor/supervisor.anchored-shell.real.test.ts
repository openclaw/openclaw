import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { isProcessAlive } from "../../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { processProbeEntrypoints } from "../process-probes-runtime.test-support.js";
import { createProcessSupervisor } from "./supervisor.js";

const activePids = new Set<number>();
const activeSupervisors = new Set<ReturnType<typeof createProcessSupervisor>>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function trackedSupervisor() {
  const supervisor = createProcessSupervisor();
  activeSupervisors.add(supervisor);
  return supervisor;
}
async function runAnchoredScript(source: string) {
  const cwd = tempDirs.make("openclaw-anchored-shell-command-");
  await writeFile(path.join(cwd, "command.cjs"), source, "utf8");
  const run = await trackedSupervisor().spawn({
    mode: "anchored-shell",
    command: `"${process.execPath}" command.cjs`,
    cwd,
  });
  const result = await run.wait();
  await run.waitForExtinction!();
  return result;
}
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

afterEach(async () => {
  for (const pid of activePids) {
    killPidIfAlive(pid);
  }
  await Promise.all([...activeSupervisors].map((supervisor) => supervisor.shutdown()));
  activePids.clear();
  activeSupervisors.clear();
});

async function createDescendantScope(
  options: { inheritLineage?: boolean; oneShot?: boolean; ignoreTerm?: boolean } = {},
) {
  const cwd = tempDirs.make("openclaw-anchored-shell-");
  const descendantPath = path.join(cwd, "descendant.mjs");
  const descendantPidPath = path.join(cwd, "descendant.pid");
  const rootPath = path.join(cwd, "root.cjs");
  const descendantArgs = JSON.stringify([descendantPath, descendantPidPath]);
  await writeFile(
    descendantPath,
    `
      import { writeFileSync } from "node:fs";
      ${fixtureReceiptClientSource(receipts.endpoint)}
      ${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
      writeFileSync(process.argv[2], String(process.pid));
      sendReceipt(process.argv[2], "ready");
      process.send?.("ready");
      await awaitRelease(process.argv[2], "release");
    `,
    "utf8",
  );
  const testSupportPath =
    process.platform === "win32"
      ? createRequire(import.meta.url).resolve("@openclaw/proc-safe/test-support")
      : undefined;
  await writeFile(
    rootPath,
    process.platform === "win32"
      ? `
        const { spawnRawWithoutConsole } = require(${JSON.stringify(testSupportPath)});
        // Native creation avoids libuv's private Job and inherits no pipe handles.
        spawnRawWithoutConsole({
          executable: process.execPath,
          args: ${descendantArgs},
        });
        ${fragmentedOutputFixture()}
      `
      : `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ${descendantArgs}, {
          stdio: ${JSON.stringify(options.inheritLineage === false ? ["ignore", "ignore", "ignore", "ipc"] : ["ignore", "ignore", "ignore", 3, "ipc"])},
        });
        child.once("message", () => {
          child.disconnect();
          child.unref();
          ${fragmentedOutputFixture()}
        });
      `,
    "utf8",
  );
  const supervisor = trackedSupervisor();
  const scopeKey = `anchored-shell:${cwd}`;
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  const run = await supervisor.spawn({
    ...(options.oneShot
      ? {
          mode: "child" as const,
          argv: [process.execPath, rootPath],
          stdinMode: "pipe-closed" as const,
        }
      : { mode: "anchored-shell" as const, command: "node root.cjs" }),
    scopeKey,
    cwd,
    env:
      process.platform === "win32"
        ? {
            ...process.env,
            COMSPEC: getWindowsCmdExePath(process.env),
            ComSpec: "Z:\\invalid-later-duplicate\\cmd.exe",
          }
        : process.env,
  });
  return {
    run,
    supervisor,
    scopeKey,
    cleanup,
    readPid: async (signal: AbortSignal) => {
      // The Windows root may exit before native child boot; readiness belongs to the descendant.
      await withinTest(receipts.waitFor(descendantPidPath, "ready"), signal);
      const pid = Number(await readFile(descendantPidPath, "utf8"));
      activePids.add(pid);
      return pid;
    },
    release: () => receipts.release(descendantPidPath, "release"),
  };
}

function fragmentedOutputFixture(): string {
  return `
    for (const [name, stream] of Object.entries({ stdout: process.stdout, stderr: process.stderr })) {
      stream.write("owned-" + name + "-one\\nowned-" + name + "-two\\n");
      stream.write(Buffer.from([0xf0, 0x9f]));
      setTimeout(() => stream.write(Buffer.from([0x98, 0x80, 0xe2, 0x82])), 50);
    }
  `;
}

async function expectPending<T>(promise: Promise<T>) {
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      setImmediate(() => resolve(false));
    }),
  ]);
  expect(settled).toBe(false);
}

describe("supervisor anchored shell real process ownership", () => {
  it.skipIf(process.platform === "win32")(
    "keeps the root command alive when it closes its inherited lineage descriptor",
    async () => {
      const result = await runAnchoredScript(
        'require("node:fs").closeSync(3); setTimeout(() => process.stdout.write("SURVIVED\\n"), 300)',
      );
      expect(result).toMatchObject({
        exitCode: 0,
        exitSignal: null,
        stdout: "SURVIVED\n",
      });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps anchored Windows commands console-free",
    async () => {
      const testSupportPath = createRequire(import.meta.url).resolve(
        "@openclaw/proc-safe/test-support",
      );
      const result = await runAnchoredScript(`
        const { hasConsoleWindow } = require(${JSON.stringify(testSupportPath)});
        process.stdout.write(JSON.stringify({ hasConsole: hasConsoleWindow() }));
        process.stderr.write("owned-console-stderr");
        process.exitCode = 23;
      `);
      expect(result).toMatchObject({
        reason: "exit",
        exitCode: 23,
        stderr: "owned-console-stderr",
      });
      expect(JSON.parse(result.stdout), "PR138751_UNEXPECTED_CONSOLE").toEqual({
        hasConsole: false,
      });
    },
  );

  it.skipIf(process.platform === "win32").for([
    { oneShot: false, ignoreTerm: false },
    { oneShot: true, ignoreTerm: true },
  ])(
    "observes children that closed inherited descriptors (oneShot=$oneShot, ignores TERM=$ignoreTerm)",
    async ({ oneShot, ignoreTerm }, { signal }) => {
      const fixture = await createDescendantScope({ inheritLineage: false, oneShot, ignoreTerm });
      const pid = await fixture.readPid(signal);
      await expect(withinTest(fixture.run.wait(), signal)).resolves.toMatchObject({
        exitCode: 0,
        exitSignal: null,
      });
      await withinTest(fixture.cleanup(), signal);
      expect(isProcessAlive(pid)).toBe(false);
    },
  );
  it("completes an otherwise idle host with a replacement command environment", async () => {
    const cwd = tempDirs.make("openclaw-anchored-shell-idle-");
    let command =
      'printf "%s\\n" "${OPENCLAW_TEST_PARENT_ENV-absent}" "${OPENCLAW_TEST_CHILD_ENV-absent}"';
    if (process.platform === "win32") {
      const commandPath = path.join(cwd, "environment.cmd");
      await writeFile(
        commandPath,
        "@echo off\r\nif defined OPENCLAW_TEST_PARENT_ENV (echo parent) else (echo absent)\r\nif defined OPENCLAW_TEST_CHILD_ENV (echo child) else (echo absent)\r\n",
      );
      command = `"${commandPath}"`;
    }
    // A separate host has no Vitest timers or IPC keeping admission alive.
    const host = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(processProbeEntrypoints.idleSupervisor),
        ),
        "replacement",
        command,
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_TEST_PARENT_ENV: "parent",
          OPENCLAW_TEST_CHILD_ENV: undefined,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(host.error).toBeUndefined();
    expect(host.status, host.stderr).toBe(0);
    const result = JSON.parse(host.stdout);
    expect({ ...result, stdout: result.stdout.replaceAll("\r\n", "\n") }).toMatchObject({
      reason: "exit",
      exitCode: 0,
      stdout: "absent\nchild\n",
    });
  });

  it("keeps a replacement's status independent of an older live child's exit", async () => {
    const supervisor = trackedSupervisor();
    const oldOutput = createDeferred();
    const spawn = async (scopeKey: string) => {
      const ready = createDeferred();
      const run = await supervisor.spawn({
        mode: "child",
        runId: "shared-correlation",
        scopeKey,
        argv: [
          process.execPath,
          "-e",
          `
              process.stdout.write("ready\\n");
              process.stdin.on("data", (data) => {
                if (data.toString() === "emit") process.stdout.write("older-output\\n");
                else process.exit(Number(data.toString()));
              });
            `,
        ],
        stdinMode: "pipe-open",
        onStdout: (chunk) => {
          if (chunk.includes("ready")) {
            ready.resolve();
          }
          if (chunk.includes("older-output")) {
            oldOutput.resolve();
          }
        },
      });
      activePids.add(run.pid!);
      await Promise.race([
        ready.promise,
        run.wait().then(() => {
          throw new Error("child exited before readiness");
        }),
      ]);
      return run;
    };
    const older = await spawn("older-backend");
    const replacement = await spawn("replacement-backend");
    const snapshot = { ...replacement.activity };
    older.stdin!.write("emit");
    await oldOutput.promise;
    expect(replacement.activity).toEqual(snapshot);
    older.stdin!.write("23");
    expect(replacement.activity).toEqual(snapshot);
    await older.wait();
    expect(isProcessAlive(replacement.pid!)).toBe(true);
    expect(replacement.activity).toEqual(snapshot);
    replacement.stdin!.write("0");
    await expect(replacement.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    expect(replacement.activity.resultSettled).toBe(true);
  });

  it("keeps a replacement supervised after an older tree with the same run ID becomes extinct", async ({
    signal,
  }) => {
    const first = await createDescendantScope();
    const descendantPid = await first.readPid(signal);
    await first.run.wait();
    expect(isProcessAlive(descendantPid)).toBe(true);
    const ready = createDeferred();
    const replacement = await first.supervisor.spawn({
      mode: "child",
      runId: first.run.runId,
      scopeKey: "fallback-real",
      argv: [process.execPath, "-e", "process.stdout.write('ready');setInterval(() => {}, 1000)"],
      stdinMode: "pipe-closed",
      onStdout: () => ready.resolve(),
    });
    const replacementPid = replacement.pid!;
    activePids.add(replacementPid);
    await ready.promise;
    first.release();
    await first.run.waitForExtinction!();
    expect(replacement.activity.resultSettled).toBe(false);
    await first.supervisor.shutdown();
    expect(isProcessAlive(replacementPid)).toBe(false);
    await expect(replacement.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
  });

  it("cancels retained descendants idempotently after root settlement and fragmented output flush", async ({
    signal,
  }) => {
    const { run, supervisor, scopeKey, cleanup, readPid } = await createDescendantScope();
    const result = await withinTest(run.wait(), signal);
    const decoder = createWindowsOutputDecoder();
    const finalTail = decoder.decode(Buffer.from([0xe2, 0x82])) + decoder.flush();

    expect(result).toMatchObject({ reason: "exit", exitCode: 0, exitSignal: null });
    expect(finalTail).not.toBe("");
    expect(result.stdout.replaceAll("\r\n", "\n")).toBe(
      `owned-stdout-one\nowned-stdout-two\n😀${finalTail}`,
    );
    expect(result.stderr.replaceAll("\r\n", "\n")).toBe(
      `owned-stderr-one\nowned-stderr-two\n😀${finalTail}`,
    );
    const descendantPid = await readPid(signal);
    expect(descendantPid).toBeGreaterThan(0);
    expect(isProcessAlive(descendantPid)).toBe(true);
    await expectPending(run.waitForExtinction!());

    supervisor.cancelScope(scopeKey);
    supervisor.cancelScope(scopeKey);
    await withinTest(Promise.all([run.waitForExtinction!(), cleanup(), cleanup()]), signal);
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    expect(isProcessAlive(descendantPid)).toBe(false);
  });
});
