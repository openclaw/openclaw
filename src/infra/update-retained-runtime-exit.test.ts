import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let base: string;
let root: string;

beforeAll(async () => {
  base = tempDirs.make("openclaw-retained-runtime-exit-");
  root = path.join(base, "openclaw");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  await fs.writeFile(path.join(root, "dist/updater.mjs"), "export {};\n");
});

afterEach(async () => {
  for (const name of await fs.readdir(base)) {
    if (name.startsWith("openclaw-update-runtime-")) {
      await fs.rm(path.join(base, name), { recursive: true, force: true });
    }
  }
});

// Each case must exit a real process: in-process signal/exit mocks cannot prove
// that the owner retires its projection before the operating system ends it.
it.skipIf(process.platform === "win32").each([
  { exit: "SIGTERM", code: 143 },
  { exit: "SIGINT", code: 130 },
  { exit: "failure-report", code: 1 },
])("releases the retained runtime before $exit exits", async ({ exit, code }) => {
  const result = spawnNodeEvalSync(
    `import fs from "node:fs/promises";
     import path from "node:path";
     import { pathToFileURL } from "node:url";
     import { MessageChannel } from "node:worker_threads";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
     import { installCliSignalExitHandlers } from ${JSON.stringify(new URL("../cli/signal-exit-barrier.ts", import.meta.url).href)};
     import { exitCliAfterOutput, runCliWithExitFinalization } from ${JSON.stringify(new URL("../cli/one-shot-exit.ts", import.meta.url).href)};
     import { defaultRuntime } from ${JSON.stringify(new URL("../runtime.ts", import.meta.url).href)};
     const root = ${JSON.stringify(root)};
     const outcome = ${JSON.stringify(exit)};
     installCliSignalExitHandlers();
     await runCliWithExitFinalization({
       run: () => withRetainedUpdateRuntime(pathToFileURL(path.join(root, "dist/updater.mjs")).href, async (retain) => {
         await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
         const retained = (await fs.readdir(path.dirname(root))).filter(name => name.startsWith("openclaw-update-runtime-"));
         process.stdout.write(JSON.stringify({ retained }) + "\\n");
         if (outcome === "failure-report") {
           defaultRuntime.error("Update failure reported");
           exitCliAfterOutput(defaultRuntime, 1);
         }
         const { port1 } = new MessageChannel();
         port1.on("message", () => {});
         process.kill(process.pid, outcome);
         await new Promise(() => {});
       }),
       onError(error) { process.stderr.write("Unexpected error: " + String(error)); process.exitCode = 2; },
     });`,
    {
      imports: [import.meta.resolve("tsx")],
      input: "",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: base,
        TMPDIR: base,
        OPENCLAW_STATE_DIR: path.join(base, "state"),
        OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
        XDG_CACHE_HOME: path.join(base, "cache"),
        OPENCLAW_LOG_LEVEL: "silent",
      },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(code);
  expect(result.signal, result.stderr).toBeNull();
  expect(result.stdout).toMatch(/"retained":\["openclaw-update-runtime-[A-Za-z0-9]{6}"\]/u);
  if (exit === "failure-report") {
    expect(result.stderr).toContain("Update failure reported");
    expect(result.stderr).not.toContain("Unexpected error:");
  }
  expect(
    (await fs.readdir(base)).filter((name) => name.startsWith("openclaw-update-runtime-")),
  ).toEqual([]);
});
