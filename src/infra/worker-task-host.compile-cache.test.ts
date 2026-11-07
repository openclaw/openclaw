import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { stageLauncherFixture } from "../../test/helpers/openclaw-launcher-fixture.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Collection prepares one compiled generation, shared by every fresh Node lifetime.
const parent = resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.compileCacheParent);

it.each(["owned", "absent", "foreign", "disabled-empty", "disabled-zero", "cache-empty"])(
  "hands the foreground launcher cache to ordinary and retained task workers: %s",
  async (mode) => {
    const root = tempDirs.make("openclaw-worker-cache-");
    await stageLauncherFixture(root);
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module","version":"2026.9.6"}');
    await fs.writeFile(
      path.join(root, "dist/entry.js"),
      "await import(" + JSON.stringify(parent.href) + ");",
    );
    const args = [
      path.join(root, "openclaw.mjs"),
      ...(mode === "absent" || mode === "foreign" ? ["status"] : ["gateway", "run"]),
    ];
    if (mode === "foreign") {
      const preload = path.join(root, "foreign.mjs");
      await fs.writeFile(
        preload,
        'import assert from "node:assert/strict";' +
          'import { enableCompileCache, constants } from "node:module";' +
          "assert.equal(enableCompileCache(" +
          JSON.stringify(path.join(root, "foreign")) +
          ").status, constants.compileCacheStatus.ENABLED);",
      );
      args.unshift("--import", pathToFileURL(preload).href);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      TMP: root,
      TEMP: root,
      TMPDIR: root,
      OPENCLAW_CACHE_FIXTURE_MODE: mode,
    };
    for (const key of [
      "NODE_OPTIONS",
      "NODE_COMPILE_CACHE",
      "NODE_DISABLE_COMPILE_CACHE",
      "OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED",
      "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
      "OPENCLAW_CACHE_FIXTURE_SHARED",
    ]) {
      delete env[key];
    }
    if (mode === "foreign") {
      env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED = "1";
    }
    if (mode === "disabled-empty") {
      env.NODE_DISABLE_COMPILE_CACHE = "";
    }
    if (mode === "disabled-zero") {
      env.NODE_DISABLE_COMPILE_CACHE = "0";
    }
    if (mode === "cache-empty") {
      env.NODE_COMPILE_CACHE = "";
    }
    const result = spawnSync(resolveTestNodeExecPath(), args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("worker-cache:verified");
  },
);
