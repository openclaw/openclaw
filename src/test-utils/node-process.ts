// Test helpers for spawning Node processes and asserting their output.
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolveNodeRuntimeExecutable } from "../infra/node-runtime-executable.js";

type NodeEvalArgsOptions = {
  evalFlag?: "--eval" | "-e";
  imports?: readonly string[];
};

type ExecNodeEvalOptions = Omit<NonNullable<Parameters<typeof execFileSync>[2]>, "encoding"> &
  NodeEvalArgsOptions & {
    encoding?: BufferEncoding;
  };

type SpawnNodeEvalOptions = Omit<NonNullable<Parameters<typeof spawnSync>[2]>, "encoding"> &
  NodeEvalArgsOptions & {
    encoding?: BufferEncoding;
  };

export function resolveTestNodeExecPath(): string {
  const nodePath = resolveNodeRuntimeExecutable();
  if (nodePath) {
    return nodePath;
  }
  throw new Error("Unable to locate a Node executable while running tests under Bun");
}

/** Builds node args for ESM eval snippets used by subprocess boundary tests. */
export function createNodeEvalArgs(source: string, options: NodeEvalArgsOptions = {}): string[] {
  const args = (options.imports ?? []).flatMap((specifier) => ["--import", specifier]);
  args.push("--input-type=module", options.evalFlag ?? "--eval", source);
  return args;
}

export function execNodeEvalSync(source: string, options: ExecNodeEvalOptions = {}): string {
  const { evalFlag, imports, ...execOptions } = options;
  return execFileSync(
    resolveTestNodeExecPath(),
    createNodeEvalArgs(source, { evalFlag, imports }),
    {
      cwd: process.cwd(),
      encoding: "utf8",
      ...execOptions,
    },
  );
}

export function spawnNodeEvalSync(
  source: string,
  options: SpawnNodeEvalOptions = {},
): SpawnSyncReturns<string> {
  const { evalFlag, imports, ...spawnOptions } = options;
  return spawnSync(resolveTestNodeExecPath(), createNodeEvalArgs(source, { evalFlag, imports }), {
    cwd: process.cwd(),
    encoding: "utf8",
    ...spawnOptions,
  });
}
