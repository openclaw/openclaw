import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { withDistArtifactOwnership } from "../../scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { TSGO_CORE_TEST_SHARDS } from "../../scripts/lib/tsgo-core-test-shards.mts";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import {
  hasSemanticTestBackend,
  overrideNativeFixtureExecutable,
} from "./native-boundary-fixture.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

it.runIf(hasSemanticTestBackend()).for(["direct", "shards"] as const)(
  "releases %s artifacts after canceling a compiler that requires forced termination",
  (entry, { signal }) =>
    lifetime.run(async () => {
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-cancel-shards-"));
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      installDistArtifactScripts(root, ["run-tsgo-core-test-shards.mts", "run-tsgo.mts"], {
        compiler: false,
        dependencies: ["@openclaw/fs-safe"],
      });
      const compiler = path.join(root, "compiler.cjs");
      fs.writeFileSync(
        compiler,
        `#!${resolveTestNodeExecPath()}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
console.log(JSON.stringify({ pid: process.pid }));
`,
      );
      fs.chmodSync(compiler, 0o755);
      overrideNativeFixtureExecutable(root, compiler);
      const clock = path.join(root, "supervisor-clock.mjs");
      // Accelerate every supervisor's existing grace period equally. Readiness and
      // process completion still use real pipes and OS signals, without sleeps.
      fs.writeFileSync(
        clock,
        `const now = Date.now.bind(Date), start = now();
Date.now = () => start + (now() - start) * 10;
`,
      );
      const ready = createDeferredCore<{ pid: number }>();
      let child: ChildProcess | undefined;
      let output = "";
      let compilerPid: number | undefined;
      const completion = lifetime.track(
        runManagedCommand({
          bin: resolveTestNodeExecPath(),
          args:
            entry === "direct"
              ? [path.join(root, "scripts/run-tsgo.mts"), "-p", "tsconfig.extensions.json"]
              : [
                  path.join(root, "scripts/run-tsgo-core-test-shards.mts"),
                  "--stripe",
                  `1/${TSGO_CORE_TEST_SHARDS.length}`,
                ],
          cwd: root,
          env: {
            ...process.env,
            OPENCLAW_CI_STATIC_EVIDENCE: "1",
            NODE_OPTIONS: `--import=${pathToFileURL(clock).href}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
          signal,
          requireProcessTreeExit: true,
          onReady: (started) => {
            child = started;
            started.stdout!.on("data", (chunk) => {
              output += String(chunk);
            });
            createInterface({ input: started.stdout! }).once("line", (line) => {
              ready.resolve(JSON.parse(line) as { pid: number });
            });
            started.stderr!.on("data", (chunk) => {
              output += String(chunk);
            });
          },
        }),
      );
      try {
        const compilerReady = await Promise.race([
          ready.promise,
          completion.then((code) => {
            throw new Error(`Shards exited before compiler readiness: ${code}\n${output}`);
          }),
        ]);
        compilerPid = compilerReady.pid;
        if (!child) {
          throw new Error("Missing shard process");
        }
        child.kill("SIGTERM");
        expect(await completion, output).toBe(143);
        expect(output).not.toContain("[ci-static:tsgo:");
        expect(() => process.kill(compilerReady.pid, 0)).toThrow();
        expect(fs.readdirSync(path.join(root, ".artifacts/dist-artifacts.lock"))).toEqual([]);
        await withDistArtifactOwnership(root, async () => {
          fs.writeFileSync(path.join(root, "next-check"), "acquired");
        });
        expect(fs.readFileSync(path.join(root, "next-check"), "utf8")).toBe("acquired");
      } finally {
        await lifetime.verifyCleanup(async () => {
          child?.stdin?.end();
          try {
            await completion;
          } finally {
            if (compilerPid !== undefined) {
              if (isProcessAlive(compilerPid)) {
                process.kill(compilerPid, "SIGKILL");
              }
              await waitForDead(compilerPid, 2_000);
            }
          }
        });
      }
    }),
);
