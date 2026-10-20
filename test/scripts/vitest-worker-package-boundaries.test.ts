import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it } from "vitest";
import {
  createVitestWorkerPackageBoundariesPlugin,
  createVitestWorkerRelativeExternalsPlugin,
} from "../../scripts/lib/vitest-worker-package-boundaries.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("keeps plugin package ownership when compiled workers move between checkout depths", async () => {
  const parent = roots.make("vitest-worker-packages-");
  const write = (filename: string, bytes: string) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  const packages = path.join(parent, "shared-packages");
  const dependency = path.join(packages, "quickjs-wasi/index.js");
  write(
    path.join(packages, "quickjs-wasi/package.json"),
    '{"type":"module","exports":"./index.js"}',
  );
  write(
    dependency,
    'export const QuickJS = {marker:"quickjs-owner"}; export const EvalFlags = {}; export class JSException extends Error {} export const MAX_STACK_SIZE = 1;\n',
  );
  write(
    path.join(packages, "@discordjs/voice/package.json"),
    '{"type":"module","exports":"./index.js"}',
  );
  write(
    path.join(packages, "@discordjs/voice/index.js"),
    'export const marker = "discord-owner";\n',
  );
  const first = path.join(parent, "first");
  const second = path.join(parent, "deeper/second");
  const output = ".artifacts/vitest-workers/run-cache-0/dist";
  const quickjs = "extensions/code-mode-quickjs/src/quickjs-runtime.ts";
  const discord = "extensions/discord/src/voice/sdk-runtime.ts";
  for (const root of [first, second]) {
    write(path.join(root, "package.json"), '{"type":"module"}');
    for (const adapter of [quickjs, discord]) {
      write(path.join(root, adapter), fs.readFileSync(path.join(repoRoot, adapter), "utf8"));
    }
    for (const plugin of ["code-mode-quickjs", "discord"]) {
      fs.symlinkSync(
        packages,
        path.join(root, "extensions", plugin, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  const worker = path.join(first, "extensions/code-mode-quickjs/src/probe.ts");
  write(
    worker,
    'import { QuickJS } from "./quickjs-runtime.js"; import { loadDiscordVoiceSdk } from "../../discord/src/voice/sdk-runtime.js"; console.log(JSON.stringify([QuickJS.marker,loadDiscordVoiceSdk().marker]));\n',
  );
  const nestedWorker = path.join(path.dirname(worker), "nested-probe.ts");
  fs.copyFileSync(worker, nestedWorker);
  const recorded: string[] = [];
  await build({
    config: false,
    cwd: first,
    root: first,
    entry: { probe: worker, "nested/probe": nestedWorker },
    outDir: path.join(first, output),
    format: "esm",
    platform: "node",
    target: "node26",
    dts: false,
    clean: false,
    logLevel: "silent",
    plugins: [
      createVitestWorkerPackageBoundariesPlugin(first, (source) => recorded.push(source)),
      createVitestWorkerRelativeExternalsPlugin(first),
    ],
    outExtensions: () => ({ js: ".js" }),
  });
  expect(new Set(recorded)).toEqual(
    new Set([path.join(first, quickjs), path.join(first, discord), dependency]),
  );
  fs.mkdirSync(path.dirname(path.join(second, output)), { recursive: true });
  fs.cpSync(path.join(first, output), path.join(second, output), { recursive: true });
  const node = resolveTestNodeExecPath();
  for (const root of [first, second]) {
    for (const filename of ["probe.js", "nested/probe.js"]) {
      const result = spawnSync(node, [path.join(root, output, filename)], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["quickjs-owner", "discord-owner"]);
    }
  }
});

it("keeps emitted module boundaries relative when copied to another slot", async () => {
  const root = roots.make("vitest-worker-module-boundaries-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const first = path.join(root, ".artifacts/vitest-workers/run-cache-0/dist");
  const second = path.join(root, ".artifacts/vitest-workers/run-cache-1/dist");
  fs.mkdirSync(first, { recursive: true });
  const source = path.join(root, "entry.ts");
  fs.writeFileSync(source, 'import { marker } from "./boundary.js"; console.log(marker);');
  await build({
    config: false,
    cwd: root,
    entry: { entry: source, "nested/entry": source },
    outDir: first,
    format: "esm",
    platform: "node",
    dts: false,
    clean: false,
    logLevel: "silent",
    plugins: [
      {
        name: "fixture-boundary",
        resolveId(id) {
          return id === "./boundary.js"
            ? { id: path.join(first, "boundary.js"), external: "relative" }
            : null;
        },
      },
      createVitestWorkerRelativeExternalsPlugin(`${root}${path.sep}`),
    ],
    outExtensions: () => ({ js: ".js" }),
  });
  fs.writeFileSync(path.join(first, "boundary.js"), 'export const marker = "owned boundary";');
  fs.cpSync(first, second, { recursive: true });
  fs.rmSync(first, { recursive: true });
  for (const entry of ["entry.js", "nested/entry.js"]) {
    const result = spawnSync(resolveTestNodeExecPath(), [path.join(second, entry)], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("owned boundary");
  }
});
