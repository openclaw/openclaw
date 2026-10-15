import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";
import {
  isRunWithEnvHelpRequest,
  parseRunWithEnvArgs,
  resolveForceKillDelayMs,
  resolveSpawnCommand,
} from "../../scripts/run-with-env.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import { hasErrnoCode } from "../../src/infra/errno.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

function withReceiptClient(source: string): string {
  return `${fixtureReceiptClientSource(receipts.endpoint)}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
${source}`;
}

async function waitForFixtureExit(
  predicate: () => boolean,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  // The wrapper may exit immediately after sending SIGKILL, without joining
  // orphan descendants. No owned handle exposes their eventual extinction.
  let tick: ReturnType<typeof setTimeout> | undefined;
  try {
    while (!predicate()) {
      await withinTest(
        new Promise<void>((resolve) => {
          tick = setTimeout(resolve, 5);
        }),
        signal,
      ).catch((cause: unknown) => {
        throw new Error(`test aborted waiting for ${label}`, { cause });
      });
    }
  } finally {
    clearTimeout(tick);
  }
}

function spawnWrapperFixture(
  tempDir: string,
  assignments: string[],
  childScript: string,
  testSignal: AbortSignal,
  env?: NodeJS.ProcessEnv,
) {
  const pidFile = path.join(tempDir, "wrapped-pid");
  const wrapper = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(scriptModuleEntrypoints.runWithEnv)),
      ...assignments,
      "--",
      "node",
      "--input-type=module",
      "-e",
      withReceiptClient(
        [
          // Publish the detached group before this fixture can create descendants.
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile + ".tmp")}, String(process.pid));`,
          `require('node:fs').renameSync(${JSON.stringify(pidFile + ".tmp")}, ${JSON.stringify(pidFile)});`,
          `sendReceipt(${JSON.stringify(pidFile)}, "ready");`,
          childScript,
        ].join("\n"),
      ),
    ],
    { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let childError: Error | undefined;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      wrapper.once("error", (error) => {
        childError = error;
      });
      wrapper.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );
  // Inherited pipes keep an unrecorded, still-starting command observable after wrapper exit.
  wrapper.stdout.resume();
  wrapper.stderr.resume();
  const signal = (value: NodeJS.Signals) => {
    return wrapper.kill(value);
  };

  return {
    signal,
    async waitForReady(filename: string, label: string) {
      // File publication precedes the receipt; close and receipts use separate
      // channels, so a close-first race must consult the durable ready record.
      const settled = completion.then(() => {
        if (!existsSync(filename)) {
          throw new Error(`wrapper exited before ${label}`);
        }
      });
      await withinTest(Promise.race([receipts.waitFor(filename, "ready"), settled]), testSignal);
    },
    async waitForExit() {
      // Bind the body wait so a stall still reaches the fixture's process cleanup.
      const exit = await withinTest(completion, testSignal);
      if (childError) {
        throw childError;
      }
      return exit;
    },
    async cleanup(this: void) {
      // Assertions have finished (or aborted); rescue now, without waiting for
      // a second wall-clock grace period before stopping the owned groups.
      // The wrapper owns tsx helper processes in its group; the wrapped command
      // creates a separate group whose identity is recorded by the fixture.
      if (
        wrapper.pid &&
        inspectManagedProcessGroup(wrapper, { errorPolicy: "indeterminate" }) !== "dead"
      ) {
        terminateManagedChild(wrapper, "SIGKILL", { processGroupFallback: "never" });
      }
      await Promise.race([receipts.waitFor(pidFile, "ready"), completion]);
      let wrappedGroup: { pid: number } | undefined;
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error(`invalid wrapped command PID; retained fixture: ${tempDir}`);
        }
        const group = { pid };
        wrappedGroup = group;
        if (inspectManagedProcessGroup(group, { errorPolicy: "indeterminate" }) !== "dead") {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (!hasErrnoCode(error, "ESRCH")) {
              throw error;
            }
          }
        }
      }
      await completion;
      if (wrappedGroup) {
        const group = wrappedGroup;
        await waitForFixtureExit(
          () => inspectManagedProcessGroup(group, { errorPolicy: "indeterminate" }) === "dead",
          `wrapped group exit before removing fixture: ${tempDir}`,
          testSignal,
        );
      }
      if (wrapper.pid) {
        await waitForFixtureExit(
          () => inspectManagedProcessGroup(wrapper, { errorPolicy: "indeterminate" }) === "dead",
          `wrapper group exit before removing fixture: ${tempDir}`,
          testSignal,
        );
      }
      rmSync(tempDir, { force: true, recursive: true });
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("run-with-env", () => {
  it("parses leading env assignments before the command separator", () => {
    expect(
      parseRunWithEnvArgs([
        "OPENCLAW_GATEWAY_PROJECT_SHARDS=1",
        "EMPTY=",
        "--",
        "node",
        "scripts/run-vitest.mjs",
        "run",
      ]),
    ).toEqual({
      env: {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "1",
        EMPTY: "",
      },
      command: "node",
      args: ["scripts/run-vitest.mjs", "run"],
    });
  });

  it("rejects missing command separators", () => {
    expect(() => parseRunWithEnvArgs(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "node"])).toThrow(
      /Usage:/u,
    );
  });

  it("prints wrapper help without spawning a command", () => {
    const result = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(scriptModuleEntrypoints.runWithEnv)),
        "--help",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node --import tsx scripts/run-with-env.mts");
    expect(result.stderr).toBe("");
  });

  it("keeps command help passthrough after the separator", () => {
    expect(
      isRunWithEnvHelpRequest(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "--", "node", "--help"]),
    ).toBe(false);
  });

  it("uses the current Node executable for bare Node command names", () => {
    const args = ["scripts/run-vitest.mjs"];
    expect(resolveSpawnCommand("node", args, "/usr/bin/node", "linux")).toEqual({
      command: "/usr/bin/node",
      args,
    });
    for (const command of ["node", "NODE", "node.exe", "Node.Exe"]) {
      expect(resolveSpawnCommand(command, args, "C:\\Node24\\node.exe", "win32")).toEqual({
        command: "C:\\Node24\\node.exe",
        args,
      });
    }
  });

  it("preserves platform-specific and explicitly pathed commands", () => {
    const args = ["scripts/run-vitest.mjs"];
    for (const command of ["NODE", "node.exe", "C:\\Tools\\node.exe"]) {
      expect(resolveSpawnCommand(command, args, "/usr/bin/node", "linux")).toEqual({
        command,
        args,
      });
    }
    expect(
      resolveSpawnCommand("C:\\Tools\\node.exe", args, "C:\\Node24\\node.exe", "win32"),
    ).toEqual({
      command: "C:\\Tools\\node.exe",
      args,
    });
  });

  it("rejects malformed force-kill grace configuration before spawning", () => {
    expect(resolveForceKillDelayMs({})).toBe(5_000);
    expect(resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "  " })).toBe(5_000);
    expect(resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "250" })).toBe(250);
    expect(
      resolveForceKillDelayMs({
        OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    for (const value of ["0", "-1", "1e3", "100ms"]) {
      expect(() => resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: value })).toThrow(
        "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer",
      );
    }

    const result = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(scriptModuleEntrypoints.runWithEnv)),
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "100ms" },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer",
    );
  });

  it.runIf(process.platform !== "win32").for(["SIGTERM", "SIGHUP", "SIGINT"] as const)(
    "forwards parent %s to the wrapped command",
    async (parentSignal, { signal }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-signals-"));
      const readyFile = path.join(tempDir, "ready");
      const signaledFile = path.join(tempDir, "signaled");
      const handlerLines = ["SIGTERM", "SIGHUP", "SIGINT"].flatMap((handledSignal) => [
        `process.on('${handledSignal}', () => {`,
        `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
        "  setTimeout(() => process.exit(0), 25);",
        "});",
      ]);
      const childScript = [
        "const fs = require('node:fs');",
        ...handlerLines,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "sendReceipt(process.env.READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const fixture = spawnWrapperFixture(
        tempDir,
        [`READY_FILE=${readyFile}`, `SIGNALED_FILE=${signaledFile}`],
        childScript,
        signal,
      );

      await runQaGatewayFixture(async () => {
        await fixture.waitForReady(readyFile, "wrapped command readiness");
        fixture.signal(parentSignal);

        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal: parentSignal });
        expect(readFileSync(signaledFile, "utf8")).toBe(parentSignal);
      }, fixture.cleanup);
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up wrapped command descendants on wrapper shutdown",
    async ({ signal }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-descendants-"));
      const readyFile = path.join(tempDir, "ready");
      const grandchildReadyFile = path.join(tempDir, "grandchild-ready");
      const grandchildPidFile = path.join(tempDir, "grandchild-pid");
      const grandchildScript = withReceiptClient(
        [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          "process.on('SIGHUP', () => {});",
          "fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');",
          "sendReceipt(process.env.GRANDCHILD_READY_FILE, 'ready');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const grandchild = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));",
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "sendReceipt(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const fixture = spawnWrapperFixture(
        tempDir,
        [
          `READY_FILE=${readyFile}`,
          `GRANDCHILD_READY_FILE=${grandchildReadyFile}`,
          `GRANDCHILD_PID_FILE=${grandchildPidFile}`,
        ],
        childScript,
        signal,
        { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "200" },
      );

      await runQaGatewayFixture(async () => {
        await fixture.waitForReady(readyFile, "wrapped command readiness");
        await fixture.waitForReady(grandchildReadyFile, "wrapped command descendant readiness");
        const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
        expect(grandchildPid).toBeGreaterThan(0);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        fixture.signal("SIGTERM");
        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        await waitForFixtureExit(
          () => !isProcessAlive(grandchildPid),
          "wrapped command descendant cleanup",
          signal,
        );
      }, fixture.cleanup);
    },
  );

  it.runIf(process.platform !== "win32")(
    "lets wrapped command descendants finish during the shutdown grace period",
    async ({ signal }) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-grace-"));
      const readyFile = path.join(tempDir, "ready");
      const gracefulFile = path.join(tempDir, "graceful");
      const grandchildReadyFile = path.join(tempDir, "grandchild-ready");
      const grandchildScript = withReceiptClient(
        [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {",
          "  setTimeout(() => {",
          "    fs.writeFileSync(process.env.GRACEFUL_FILE, 'done');",
          "    process.exit(0);",
          "  }, 75);",
          "});",
          "fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');",
          "sendReceipt(process.env.GRANDCHILD_READY_FILE, 'ready');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "sendReceipt(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const fixture = spawnWrapperFixture(
        tempDir,
        [
          `READY_FILE=${readyFile}`,
          `GRACEFUL_FILE=${gracefulFile}`,
          `GRANDCHILD_READY_FILE=${grandchildReadyFile}`,
        ],
        childScript,
        signal,
        {
          ...process.env,
          OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
        },
      );

      await runQaGatewayFixture(async () => {
        await fixture.waitForReady(readyFile, "wrapped command readiness");
        await fixture.waitForReady(grandchildReadyFile, "wrapped command descendant readiness");
        fixture.signal("SIGTERM");

        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(readFileSync(gracefulFile, "utf8")).toBe("done");
      }, fixture.cleanup);
    },
  );
});
