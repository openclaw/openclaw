import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
} from "../infra/runtime-worker-url.js";
import { resolvePluginPreparationExecArgv } from "./plugin-preparation-exec-argv.js";

const original = process.execArgv;
const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  process.execArgv = original;
});

it("preserves selected resolution flags alongside the preparation preload", () => {
  const url = new URL("./plugin-generation-preparation.worker.ts", import.meta.url);
  process.execArgv = [
    "--inspect=0",
    "-C",
    "custom",
    "--conditions=custom",
    "--conditions",
    "literal,condition",
    "--no-addons",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
  ];
  expect(resolvePluginPreparationExecArgv(url)).toEqual([
    ...resolveRuntimeWorkerThreadExecArgv(url),
    "--conditions=custom",
    "--conditions=literal,condition",
    "--no-addons",
    "--preserve-symlinks",
  ]);
});

it("publishes and loads the selected closure with the caller's real worker conditions", () => {
  const home = temp.make("plugin-snapshot-worker-options-");
  const support = new URL("./plugin-preparation-exec-argv.test-support.ts", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=snapshot-custom",
      "--no-addons",
      ...resolveRuntimeWorkerArgv(support),
      "--snapshot-worker-options",
      home,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 45_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
