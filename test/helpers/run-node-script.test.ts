import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "./fixture-lifetime.js";
import { waitForDead, waitForPidFile } from "./process-wait.js";
import { withinTest } from "./promise.js";
import { runNodeScript } from "./run-node-script.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

let cleanupFixture: (() => Promise<void>) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Timeout hooks can run before the suspended body finishes its finally block.
    await cleanupFixture?.();
    cleanupFixture = undefined;
    cleanup();
  }),
);

function makeParent(leaf: string, directory: string, detached = false, status = 0) {
  const script = join(directory, "parent.mjs");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], { detached: ${detached}, stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => process.exit(${status}));
`,
  );
  return script;
}

function expectOutput(result: unknown, stdout: string, stderr: string, status = 0) {
  expect(result).toEqual({ error: undefined, status, stdout, stderr });
}

it("captures inherited output written after the script exits", async () => {
  const script = makeParent(
    `
process.on("disconnect", () => {
  process.stdout.write("drained stdout\\n");
  process.stderr.write("drained stderr\\n");
});
process.send("ready");
`,
    tempDirs.make("openclaw-node-script-output-"),
    false,
    17,
  );
  const result = await runNodeScript(script, process.env, 5_000);
  expectOutput(result, "drained stdout\n", "drained stderr\n", 17);
});

it.for(["node", "current"] as const)(
  "builds source worker arguments for the selected %s runtime",
  async (runtime) => {
    const script = join(tempDirs.make("openclaw-node-script-runtime-"), "worker.ts");
    writeFileSync(
      script,
      `enum Answer { value = 42 }
console.log(JSON.stringify({ answer: Answer.value, bun: Boolean(process.versions.bun), args: process.argv.slice(2) }));
`,
    );
    const result = await runNodeScript(
      (workerArgv) => [...workerArgv(pathToFileURL(script)), "worker-argument"],
      process.env,
      5_000,
      { executable: runtime === "current" ? process.execPath : undefined },
    );
    expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
    expect(JSON.parse(result.stdout)).toEqual({
      answer: 42,
      bun: runtime === "current" && Boolean(process.versions.bun),
      args: ["worker-argument"],
    });
  },
);

it.for(["at limit", "stdout overflow", "stderr overflow"])(
  "preserves independent 2 MiB output failure boundaries: %s",
  async (mode) => {
    const directory = tempDirs.make("openclaw-node-script-buffer-");
    const script = join(directory, "output.mjs");
    const pidFile = join(directory, "pid");
    const maxBuffer = 2 * 1024 * 1024;
    writeFileSync(
      script,
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const mode=${JSON.stringify(mode)}, bytes=${maxBuffer};
if(mode==='at limit') {
  process.stdout.write(Buffer.alloc(bytes,97));
  process.stderr.write(Buffer.alloc(bytes,98));
} else {
  process[mode.split(' ')[0]].write(Buffer.alloc(bytes+1,97));
  setTimeout(()=>process.exit(73),10000);
}
`,
    );
    const result = await runNodeScript(script, process.env, 5_000, { maxBuffer });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    if (mode === "at limit") {
      expectOutput(result, "a".repeat(maxBuffer), "b".repeat(maxBuffer));
    } else {
      expect(result).toMatchObject({
        error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
        status: null,
      });
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxBuffer);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxBuffer);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retains inputs when captured command output leaves cleanup uncertain",
  async ({ signal }) => {
    const ownerRoot = tempDirs.make("node-script-owner-");
    const owner = createVitestResourceOwner(ownerRoot);
    const env = { ...process.env, TMPDIR: ownerRoot, TMP: ownerRoot, TEMP: ownerRoot };
    const fixture = createFixtureLifetime(ownerRoot);
    const directory = fixture.createTempDir("openclaw-node-script-uncertain-");
    const pidFile = join(directory, "leaf.pid");
    const release = join(directory, "release");
    const input = join(directory, "input");
    const read = join(directory, "read");
    writeFileSync(input, "still owned");
    const leaf = `
const fs=require('node:fs');
const deadline=setTimeout(()=>process.exit(73),15000);
const poll=setInterval(()=>{
  if(!fs.existsSync(${JSON.stringify(release)})) return;
  fs.writeFileSync(${JSON.stringify(read)},fs.readFileSync(${JSON.stringify(input)}));
  clearInterval(poll);clearTimeout(deadline);
},5);
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
process.send('ready');process.disconnect();
`;
    const script = makeParent(leaf, directory, true);
    const command = fixture.track(
      runNodeScript(script, env, undefined, { signal, requireProcessTreeExit: true }),
    );
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        await command;
        // Join the escaped leaf before disposing deliberately retained inputs.
        if (existsSync(pidFile)) {
          writeFileSync(release, "release");
          const pid = await waitForPidFile(pidFile, AbortSignal.timeout(2_000));
          await waitForDead(pid, AbortSignal.timeout(15_000));
        }
        await fixture.cleanup();
        rmSync(directory, { recursive: true, force: true });
      })());
    cleanupFixture = cleanup;
    try {
      const result = await command;
      expect(result.error).toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "indeterminate",
      });
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup unverified");
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      expect(existsSync(directory)).toBe(true);
      writeFileSync(release, "release");
      // The leaf writes its PID before ready; only that IPC lets the parent exit.
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      await withinTest(waitForDead(pid, signal), signal);
      expect(readFileSync(read, "utf8")).toBe("still owned");
    } finally {
      await cleanup();
    }
  },
);
