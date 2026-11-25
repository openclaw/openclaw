import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const root = process.cwd();
const compiler = path.join(root, "scripts/lib/vitest-worker-compiler.mts");
const fixture = path.join(root, "test/scripts/fixtures/vitest-worker-scheduling.cjs");

it.for([
  { name: "CI shared failure", env: { CI: "1" }, failShared: true, maxActive: 1 },
  { name: "GitHub Actions only", env: { GITHUB_ACTIONS: "true" }, failShared: false, maxActive: 1 },
  { name: "large local host", env: {}, failShared: false, maxActive: 2 },
])(
  "owns cached compiler graph concurrency on $name",
  async ({ env, failShared, maxActive }, { signal, onTestFinished }) => {
    const lifetime = createFixtureLifetime();
    onTestFinished(() => lifetime.cleanup());
    await lifetime.run(async () => {
      let joined = true;
      const slot = `run-cache-${randomInt(1_000_000_000_000)}`;
      const { directory } = await lifetime.acquire(async (rejectAfterCleanup) => {
        const created: string[] = [];
        const cleanup = async () => {
          if (!joined) {
            throw new Error("Compiler fixture remains unjoined");
          }
          for (const ownedDirectory of created.toReversed()) {
            await fs.promises.rm(ownedDirectory, { recursive: true, force: true });
          }
        };
        const reserved = path.join(root, ".artifacts/vitest-workers", slot);
        try {
          // Reserve both paths exclusively so failure cleanup cannot remove another generation.
          for (const target of [
            reserved,
            path.join(root, ".artifacts/vitest-worker-cache", slot),
          ]) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.mkdirSync(target, { mode: 0o700 });
            created.push(target);
          }
          fs.writeFileSync(path.join(reserved, "package.json"), '{"type":"module"}\n');
          return { directory: reserved, cleanup };
        } catch (error) {
          return rejectAfterCleanup(error, cleanup);
        }
      });
      joined = false;
      const result = await lifetime.track(
        runNodeScript(
          [fixture, compiler, directory, failShared ? "fail-shared" : "fail-preserved"],
          testRunnerFixtureEnv({
            ...env,
            OPENCLAW_VITEST_WORKER_CACHE: "1",
            NODE_OPTIONS: "",
            NODE_PATH: "",
            NAPI_RS_NATIVE_LIBRARY_PATH: "",
            NAPI_RS_WASI_FLAVOR: "",
            NAPI_RS_FORCE_WASI: "",
          }),
          undefined,
          {
            cwd: root,
            signal,
            maxBuffer: 64 * 1024,
            requireProcessTreeExit: process.platform !== "win32",
          },
        ),
      );
      joined = !hasUnjoinedWork(result.error);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("[vitest-workers] local cache miss");
      expect(result.stderr).toContain("controlled tsdown failure");
      const observed = JSON.parse(result.stdout) as {
        events: string[];
        active: number;
        maxActive: number;
        failure: { active: number; events: string[] };
        execArgv: string[];
      };
      expect(observed.execArgv).toEqual([]);
      expect(observed.active).toBe(0);
      // Join before reporting failure; process exit alone can hide pending build callbacks.
      expect(observed.failure.active).toBe(0);
      expect(observed.failure.events).toEqual(observed.events);
      expect(observed.maxActive).toBe(maxActive);
      if (failShared) {
        expect(observed.events).toEqual(["start:shared", "end:shared"]);
      } else {
        expect(observed.events.filter((event) => event === "start:preserved")).toHaveLength(1);
        expect(observed.events.at(-1)).toBe(maxActive === 1 ? "end:preserved" : "end:shared");
      }
    });
  },
);
