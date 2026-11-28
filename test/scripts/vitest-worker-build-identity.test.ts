import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import {
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import { retainVitestWorkerArtifacts } from "../../scripts/lib/vitest-worker-cache.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

it("inherits current host identity on cold compilation and real cache restoration", async ({
  signal,
  onTestFinished,
}) => {
  const root = process.cwd();
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  await lifetime.run(async () => {
    const slot = `run-cache-${randomInt(1_000_000_000_000)}`;
    let joined = true;
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
        for (const target of [reserved, path.join(root, ".artifacts/vitest-worker-cache", slot)]) {
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
    const metadata = path.join(
      lifetime.createTempDir("worker-host-", os.tmpdir()),
      "build-info.json",
    );
    const firstHost = {
      version: "2026.11.1",
      commit: "a".repeat(40),
      builtAt: "2026-11-01T00:00:00.000Z",
      buildId: "host-first",
    };
    const secondHost = {
      ...firstHost,
      builtAt: "2026-11-02T00:00:00.000Z",
      buildId: "host-second",
    };
    const run = async (mode: "cold" | "restore") => {
      joined = false;
      const result = await lifetime.track(
        runNodeScript(
          [
            path.join(root, "test/scripts/fixtures/vitest-worker-build-identity.cjs"),
            path.join(root, "scripts/lib/vitest-worker-compiler.mts"),
            directory,
            metadata,
            mode,
          ],
          testRunnerFixtureEnv({
            CI: "1",
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
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout) as { builds: number; execArgv: string[] };
      expect(observed.execArgv).toEqual([]);
      expect(result.stderr).toContain(
        `[vitest-workers] local cache ${mode === "cold" ? "miss" : "hit"}`,
      );
      if (mode === "cold") {
        expect(observed.builds).toBeGreaterThan(0);
      } else {
        expect(observed.builds).toBe(0);
        expect(result.stderr).toContain("[vitest-workers] reused local compiler outputs");
      }
      await verifyVitestWorkerArtifacts(directory);
      return JSON.parse(
        fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
      ) as VitestWorkerManifest;
    };
    const readIdentity = () =>
      JSON.parse(fs.readFileSync(path.join(directory, "dist/build-info.json"), "utf8"));
    fs.writeFileSync(metadata, JSON.stringify(firstHost));
    const cold = await run("cold");
    expect(readIdentity()).toEqual(firstHost);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))).toEqual({
      type: "module",
    });
    expect(await retainVitestWorkerArtifacts(root, directory, cold)).toBe(true);
    // Retention transfers outputs, leaving this exclusive slot ready for a new
    // invocation. Its unchanged path remains part of the real cache signature.
    fs.writeFileSync(metadata, JSON.stringify(secondHost));
    const restored = await run("restore");
    expect(readIdentity()).toEqual(secondHost);
    expect(restored.identity).not.toBe(cold.identity);
    expect(restored.outputs["build-info.json"]).not.toBe(cold.outputs["build-info.json"]);
    const compiledOutputs = (manifest: VitestWorkerManifest) =>
      Object.fromEntries(
        Object.entries(manifest.outputs).filter(([name]) => name !== "build-info.json"),
      );
    expect(compiledOutputs(restored)).toEqual(compiledOutputs(cold));
    expect(restored.inputs).toEqual(cold.inputs);
  });
});
