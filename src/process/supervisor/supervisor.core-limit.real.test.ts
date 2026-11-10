import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { serviceChildHostTransportPrelude } from "./adapters/child.service-lifecycle.test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "linux")(
  "disables agent and descendant cores without changing Gateway helper limits or argv0",
  async () => {
    const directory = tempDirs.make("openclaw-core-limit-");
    const source = `
      import { readFileSync } from "node:fs";
      ${await serviceChildHostTransportPrelude(directory)}
      const { createProcessSupervisor } = await import(${JSON.stringify(new URL("./supervisor.ts", import.meta.url).href)});
      const limits = () => readFileSync('/proc/self/limits', 'utf8').match(/^Max core file size\\s+(\\S+)\\s+(\\S+)/m).slice(1);
      const before = limits();
      const supervisor = createProcessSupervisor();
      const results = [];
      try {
        for (const executionIntent of ['agent-tool', 'gateway-internal']) {
          const code = ${JSON.stringify(String.raw`
            const fs = require('node:fs');
            const { execFileSync } = require('node:child_process');
            const own = fs.readFileSync('/proc/self/limits', 'utf8').match(/^Max core file size\s+(\S+)\s+(\S+)/m).slice(1);
            const descendant = execFileSync('/bin/sh', ['-c', 'ulimit -Sc; ulimit -Hc'], { encoding: 'utf8' }).trim().split('\n');
            console.log(JSON.stringify({ own, descendant, argv0: process.argv0 }));
          `)};
          const run = await withTransport(() => supervisor.spawn({
            executionIntent, mode: 'child', runId: executionIntent,
            argv: [process.execPath, '-e', code], argv0: 'core-limit-fixture',
            exactEnv: true, env: process.env,
          }));
          results.push(await run.wait());
          await run.waitForExtinction?.();
        }
      } finally { await supervisor.shutdown(); }
      console.log(JSON.stringify({ before, after: limits(), results }));
    `;
    // Set a positive limit in an isolated host: CI's soft core limit may already be zero.
    const { stdout } = await execFileAsync(
      "prlimit",
      [
        "--core=1048576:1048576",
        "--",
        process.execPath,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        source,
      ],
      { env: { ...process.env, OPENCLAW_SERVICE_MARKER: "core-limit-fixture" }, timeout: 30_000 },
    );
    const observed = JSON.parse(stdout.trim());
    expect(observed.before).toEqual(["1048576", "1048576"]);
    expect(observed.after).toEqual(observed.before);
    expect(observed.results).toHaveLength(2);
    for (const result of observed.results) {
      expect(result).toMatchObject({ reason: "exit", exitCode: 0, exitSignal: null });
    }
    expect(JSON.parse(observed.results[0].stdout)).toEqual({
      own: ["0", "0"],
      descendant: ["0", "0"],
      argv0: "core-limit-fixture",
    });
    const internal = JSON.parse(observed.results[1].stdout);
    expect(internal.own).toEqual(observed.before);
    expect(internal.descendant.every((limit: string) => Number(limit) > 0)).toBe(true);
    expect(internal.argv0).toBe("core-limit-fixture");
  },
);
