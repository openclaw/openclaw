import * as childProcess from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { afterEach, vi } from "vitest";
import * as qaAuth from "../../scripts/lib/qa-codex-auth-env.mts";
import * as postbuild from "../../scripts/runtime-postbuild.mts";
import { importFreshModule } from "../../src/plugin-sdk/test-helpers/import-fresh.js";

type TestWritable = { isTTY?: boolean; write(value: string | Uint8Array): unknown };
type RunNodeFixture = {
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: childProcess.SpawnOptions) => unknown;
  spawnSync?: (
    command: string,
    args: string[],
    options: childProcess.SpawnSyncOptionsWithStringEncoding,
  ) => { error?: NodeJS.ErrnoException; status: number | null; stdout?: string | null };
  fs?: typeof fs;
  stderr?: TestWritable;
  stdout?: TestWritable;
  process?: NodeJS.Process;
  signalProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean | void;
  execPath?: string;
  platform?: NodeJS.Platform;
  readCodexApiKey?: qaAuth.ReadQaCodexApiKey;
  runRuntimePostBuild?: (
    params?: Parameters<typeof postbuild.runRuntimePostBuild>[0],
  ) => void | Promise<void>;
};
let generation = 0;

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:process");
  vi.doUnmock("../../scripts/runtime-postbuild.mts");
  vi.doUnmock("../../scripts/lib/qa-codex-auth-env.mts");
});

export async function runNodeMain(params: RunNodeFixture = {}) {
  const overrides = {
    // Imported script entry guards still observe the native invocation.
    argv: process.argv,
    env: params.env ?? process.env,
    cwd: () => params.cwd ?? process.cwd(),
    stderr: params.stderr ?? process.stderr,
    stdout: params.stdout ?? process.stdout,
    execPath: params.execPath ?? process.execPath,
    platform: params.platform ?? process.platform,
    ...(params.signalProcess ? { kill: params.signalProcess } : {}),
  };
  const fixtureProcess = new Proxy(params.process ?? process, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) {
        return Reflect.get(overrides, key);
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.doMock("node:process", () => ({ default: fixtureProcess }));
  vi.doMock("node:child_process", () => ({
    ...childProcess,
    spawn: params.spawn ?? childProcess.spawn,
    spawnSync: params.spawnSync ?? childProcess.spawnSync,
  }));
  vi.doMock("node:fs", () => ({ ...fs, default: params.fs ?? fs }));
  vi.doMock("../../scripts/runtime-postbuild.mts", () => ({
    ...postbuild,
    runRuntimePostBuild: params.runRuntimePostBuild ?? postbuild.runRuntimePostBuild,
  }));
  vi.doMock("../../scripts/lib/qa-codex-auth-env.mts", () => ({
    ...qaAuth,
    resolveQaCodexApiKeyEnvPatch: (
      options: Parameters<typeof qaAuth.resolveQaCodexApiKeyEnvPatch>[0],
    ) =>
      qaAuth.resolveQaCodexApiKeyEnvPatch({ ...options, readCodexApiKey: params.readCodexApiKey }),
  }));
  // Refresh only the runner: service-publication and artifact-lock tests retain
  // the real owner module instances they instrumented before calling this boundary.
  const runner = await importFreshModule<typeof import("../../scripts/run-node.mts")>(
    import.meta.url,
    `../../scripts/run-node.mts?boundary=${generation++}`,
  );
  return await runner.runNodeMain({ cwd: params.cwd, args: params.args, env: params.env });
}
