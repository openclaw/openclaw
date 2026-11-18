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
import {
  fixtureReadyBeforeSettlement,
  isProcessPresent as isProcessAlive,
  waitForProcessObservation as waitForFixtureExit,
} from "./run-process.test-support.js";

const wrapperArgv = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(scriptModuleEntrypoints.runWithEnv),
);
function runWrapper(args: string[], env = process.env) {
  return spawnSync(process.execPath, [...wrapperArgv, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

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

const groupPresent = (group: { pid?: number }) =>
  inspectManagedProcessGroup(group, { errorPolicy: "indeterminate" }) !== "dead";

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
      ...wrapperArgv,
      ...assignments,
      "--",
      "node",
      "--input-type=module",
      "-e",
      withReceiptClient(`
const fs = require('node:fs');
// Publish the detached group before this fixture can create descendants.
fs.writeFileSync(${JSON.stringify(pidFile + ".tmp")}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + ".tmp")}, ${JSON.stringify(pidFile)});
sendReceipt(${JSON.stringify(pidFile)}, "ready");
${childScript}`),
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
  return {
    signal: (value: NodeJS.Signals) => wrapper.kill(value),
    async waitForReady(filename: string) {
      await withinTest(fixtureReadyBeforeSettlement(receipts, filename, completion), testSignal);
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
      // Rescue both the wrapper's helpers and the separate wrapped command group.
      if (wrapper.pid && groupPresent(wrapper)) {
        terminateManagedChild(wrapper, "SIGKILL", { processGroupFallback: "never" });
      }
      await Promise.race([receipts.waitFor(pidFile, "ready"), completion]);
      let wrappedGroup: { pid: number } | undefined;
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error(`invalid wrapped command PID; retained fixture: ${tempDir}`);
        }
        wrappedGroup = { pid };
        if (groupPresent(wrappedGroup)) {
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
          () => !groupPresent(group),
          `wrapped group exit before removing fixture: ${tempDir}`,
          testSignal,
        );
      }
      if (wrapper.pid) {
        await waitForFixtureExit(
          () => !groupPresent(wrapper),
          `wrapper group exit before removing fixture: ${tempDir}`,
          testSignal,
        );
      }
      rmSync(tempDir, { force: true, recursive: true });
    },
  };
}

function descendantFixture(signal: AbortSignal, graceful: boolean) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-descendants-"));
  const files = {
    READY_FILE: path.join(tempDir, "ready"),
    GRANDCHILD_READY_FILE: path.join(tempDir, "grandchild-ready"),
    GRANDCHILD_PID_FILE: path.join(tempDir, "grandchild-pid"),
    GRACEFUL_FILE: path.join(tempDir, "graceful"),
  };
  const grandchild = withReceiptClient(`
const fs = require('node:fs');
process.on('SIGTERM', () => {
  if (${graceful}) setTimeout(() => {
    fs.writeFileSync(process.env.GRACEFUL_FILE, 'done');
    process.exit(0);
  }, 75);
});
if (!${graceful}) process.on('SIGHUP', () => {});
fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');
sendReceipt(process.env.GRANDCHILD_READY_FILE, 'ready');
setInterval(() => {}, 1000);
`);
  const fixture = spawnWrapperFixture(
    tempDir,
    Object.entries(files).map(([key, value]) => `${key}=${value}`),
    `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
if (!${graceful}) fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
fs.writeFileSync(process.env.READY_FILE, 'ready');
sendReceipt(process.env.READY_FILE, 'ready');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    signal,
    {
      ...process.env,
      OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: graceful ? String(MAX_TIMER_TIMEOUT_MS + 1) : "200",
    },
  );
  return {
    ...fixture,
    files,
    async ready() {
      await fixture.waitForReady(files.READY_FILE);
      await fixture.waitForReady(files.GRANDCHILD_READY_FILE);
    },
  };
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
      env: { OPENCLAW_GATEWAY_PROJECT_SHARDS: "1", EMPTY: "" },
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
    const result = runWrapper(["--help"]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: node --import tsx scripts/run-with-env.mts");
  });

  it("keeps command help passthrough after the separator", () => {
    expect(
      isRunWithEnvHelpRequest(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "--", "node", "--help"]),
    ).toBe(false);
  });

  it.each([
    ["linux", "node", "/usr/bin/node"],
    ["win32", "NODE", "C:\\Node24\\node.exe"],
    ["win32", "Node.Exe", "C:\\Node24\\node.exe"],
    ["linux", "NODE", "NODE"],
    ["linux", "node.exe", "node.exe"],
    ["win32", "C:\\Tools\\node.exe", "C:\\Tools\\node.exe"],
  ] as const)("resolves %s command %s to %s", (platform, command, expected) => {
    const args = ["scripts/run-vitest.mjs"];
    const execPath = platform === "win32" ? "C:\\Node24\\node.exe" : "/usr/bin/node";
    expect(resolveSpawnCommand(command, args, execPath, platform)).toEqual({
      command: expected,
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

    const result = runWrapper(
      [
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "100ms" },
    );

    expect(result).toMatchObject({ status: 2, stdout: "" });
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
      const fixture = spawnWrapperFixture(
        tempDir,
        [`READY_FILE=${readyFile}`, `SIGNALED_FILE=${signaledFile}`],
        `
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(signal, () => {
    fs.writeFileSync(process.env.SIGNALED_FILE, signal);
    setTimeout(() => process.exit(0), 25);
  });
}
fs.writeFileSync(process.env.READY_FILE, 'ready');
sendReceipt(process.env.READY_FILE, 'ready');
setInterval(() => {}, 1000);
`,
        signal,
      );

      await runQaGatewayFixture(async () => {
        await fixture.waitForReady(readyFile);
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
      const fixture = descendantFixture(signal, false);

      await runQaGatewayFixture(async () => {
        await fixture.ready();
        const grandchildPid = Number(readFileSync(fixture.files.GRANDCHILD_PID_FILE, "utf8"));
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
      const fixture = descendantFixture(signal, true);

      await runQaGatewayFixture(async () => {
        await fixture.ready();
        fixture.signal("SIGTERM");

        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(readFileSync(fixture.files.GRACEFUL_FILE, "utf8")).toBe("done");
      }, fixture.cleanup);
    },
  );
});
