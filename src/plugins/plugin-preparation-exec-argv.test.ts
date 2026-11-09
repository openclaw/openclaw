import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import { resolvePluginPreparationExecArgv } from "./plugin-preparation-exec-argv.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

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
    ...(process.versions.bun ? [] : ["--experimental-require-module"]),
    "--preserve-symlinks",
  ]);
});

function runScenario({
  nodeOptions,
  flags,
  ...expected
}: {
  nodeOptions?: string;
  flags: string[];
  publication: boolean;
  shared: boolean;
  addons: number;
  sync: number;
  environment: number;
}) {
  const home = temp.make("plugin-snapshot-worker-options-");
  const support = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.snapshotWorkerOptions);
  const result = spawnSync(
    process.execPath,
    [
      ...flags,
      ...resolveRuntimeWorkerArgv(support),
      "--snapshot-worker-options",
      home,
      JSON.stringify(expected),
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
        NODE_OPTIONS: nodeOptions,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

it("matches actual NODE_OPTIONS and CLI flag precedence in the host and preparation worker", () => {
  runScenario({
    publication: false,
    shared: false,
    nodeOptions: '--conditions="snapshot env" --no-addons --no-experimental-require-module',
    flags: ["--conditions=snapshot-custom", "--addons"],
    addons: process.versions.bun ? 7 : 99,
    sync: process.versions.bun ? 11 : 3,
    environment: 23,
  });
});

it.each([
  { shared: false, nodeOptions: undefined, sync: 11, environment: 1 },
  {
    shared: true,
    nodeOptions: '--conditions="snapshot env"',
    sync: 11,
    environment: 23,
  },
])("publishes and loads the selected closure with real worker conditions: %j", (scenario) => {
  // Darwin private snapshot creation itself requires addons; disabled-addon policy is proven above.
  runScenario({
    publication: true,
    ...scenario,
    flags: ["--conditions=snapshot-custom"],
    addons: 99,
  });
});
