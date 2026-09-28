import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead, waitForFixtureFile } from "../helpers/process-wait.js";
import { withTestTimeout } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

describe.skipIf(process.platform === "win32")("check-changed public wrapper cancellation", () => {
  it.each(["resistant", "cooperative", "failure"] as const)(
    "joins a %s check and stops admitting commands",
    async (mode) => {
      await fixture.run(async () => {
        const cwd = fixture.createTempDir("check-changed-cancellation-");
        const wrapperPath = path.resolve("scripts/check-changed.mjs");
        const implementationPath = path.resolve("scripts/check-changed.mts");
        const commandsPath = path.join(cwd, "commands.jsonl");
        const pidPaths = ["implementation", "command", "descendant"].map((name) =>
          path.join(cwd, `${name}.pid`),
        );
        const readyPath = path.join(cwd, "ready.pid");
        const clockPath = path.join(cwd, "supervisor-clock.mjs");
        const binDir = path.join(cwd, "bin");
        fs.mkdirSync(binDir);
        // Exercise the real wrapper and managed owner. Scale their deadlines together;
        // fixture readiness, leaf processes, and harness cleanup keep real time.
        fs.writeFileSync(
          clockPath,
          `if (process.argv[1] === ${JSON.stringify(implementationPath)}) {
  const realNow = Date.now.bind(Date);
  const startedAt = realNow();
  Date.now = () => startedAt + (realNow() - startedAt) * 10;
} else if (process.argv[1] === ${JSON.stringify(wrapperPath)}) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay / 10, ...args);
}
`,
        );
        const descendantSource = `
const fs = require("node:fs");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => fs.writeSync(2, "descendant received " + signal + "\\n"));
}
process.on("message", () => {
  fs.writeSync(1, "descendant output tail\\n");
  process.exit(0);
});
setTimeout(() => process.exit(98), 15000);
process.send("ready");
`;
        fs.writeFileSync(
          path.join(binDir, "pnpm"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(args) + "\\n");
if (args.length !== 1 || args[0] !== "check:no-conflict-markers") {
  console.error("unexpected fixture command: " + JSON.stringify(args));
  process.exit(99);
}
if (${JSON.stringify(mode)} === "failure") {
  console.error("fixture check failed");
  process.exit(7);
}
fs.writeFileSync(${JSON.stringify(pidPaths[0])}, String(process.ppid));
fs.writeFileSync(${JSON.stringify(pidPaths[1])}, String(process.pid));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
if (child.pid) fs.writeFileSync(${JSON.stringify(pidPaths[2])}, String(child.pid));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    fs.writeSync(2, "command received " + signal + "\\n");
    if (${JSON.stringify(mode)} === "cooperative" && child.connected) child.send("finish");
  });
}
child.once("close", () => {
  fs.writeSync(1, "command output tail\\n");
  process.exit(0);
});
setTimeout(() => process.exit(98), 15000);
child.once("message", () => {
  fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
});
`,
          { mode: 0o755 },
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          // This fixture deliberately exercises the local pnpm leaf on CI too.
          CI: "",
          GITHUB_ACTIONS: "",
          OPENCLAW_TESTBOX: "",
          PATH: [binDir, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(clockPath).href}`]
            .filter(Boolean)
            .join(" "),
        };
        let wrapper: ChildProcess | undefined;
        const completion = fixture.track(
          runNodeScript([wrapperPath, "--staged", "--", "README.md"], env, 10_000, {
            cwd,
            maxBuffer: 64 * 1024,
            onReady(child) {
              wrapper = child;
            },
          }),
        );
        const readOwnedPids = () =>
          pidPaths.flatMap((pidPath) => {
            if (!fs.existsSync(pidPath)) {
              return [];
            }
            const pid = Number(fs.readFileSync(pidPath, "utf8"));
            if (!Number.isSafeInteger(pid) || pid <= 1) {
              throw new Error(`Invalid fixture pid in ${pidPath}`);
            }
            return [pid];
          });
        try {
          if (mode !== "failure") {
            // The receipt is written only after both leaf signal handlers are installed.
            await withTestTimeout(
              waitForFixtureFile(readyPath, completion),
              5_000,
              "changed-check command did not become ready",
            );
            expect(readOwnedPids()).toHaveLength(3);
            expect(wrapper?.kill("SIGTERM")).toBe(true);
          }
          const result = await completion;
          expect(result.error, result.stderr).toBeUndefined();
          expect(result.status, result.stderr).toBe(mode === "failure" ? 7 : 143);
          expect(result.stderr.trim().split("\n").at(-1)).toBe(
            `[check:changed] FAILED (exit ${mode === "failure" ? 7 : 143})`,
          );
          expect(fs.readFileSync(commandsPath, "utf8").trim()).toBe(
            JSON.stringify(["check:no-conflict-markers"]),
          );
          // Check before fixture teardown: a closed outer pipe alone does not prove
          // the implementation's detached command group has stopped.
          expect(readOwnedPids().filter(isProcessAlive)).toEqual([]);
          if (mode === "cooperative") {
            expect(result.stdout).toContain("descendant output tail\ncommand output tail\n");
          } else if (mode === "resistant") {
            expect(result.stderr).toContain("command received SIGTERM");
            expect(result.stderr).toContain("descendant received SIGTERM");
          }
        } finally {
          await fixture.verifyCleanup(async () => {
            // A pre-fix wrapper can orphan these exact fixture PIDs. Reap only those
            // recorded by the fixture leaf; never broaden cleanup to process-name scans.
            const pids = [...readOwnedPids(), ...(wrapper?.pid ? [wrapper.pid] : [])];
            for (const pid of pids) {
              if (isProcessAlive(pid)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                    throw error;
                  }
                }
              }
            }
            await Promise.all([
              ...pids.map((pid) => waitForDead(pid, 2_000)),
              withTestTimeout(completion, 2_000, "wrapper output did not close during cleanup"),
            ]);
          });
        }
      });
    },
    20_000,
  );
});
