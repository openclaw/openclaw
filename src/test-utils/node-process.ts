// Test helpers for spawning Node processes and asserting their output.
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

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
  if (!process.versions.bun) {
    return process.execPath;
  }

  // Bun's --bun mode prepends a node shim that points back to Bun. Walk every
  // PATH candidate and accept only a process that identifies itself as Node.
  const executableNames =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((extension) => `node${extension.toLowerCase()}`)
      : ["node"];
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => executableNames.map((name) => path.join(directory, name)));

  for (const candidate of new Set(candidates)) {
    try {
      const nodePath = execFileSync(
        candidate,
        ["-p", "process.versions.bun ? '' : process.execPath"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        },
      ).trim();
      if (nodePath) {
        return nodePath;
      }
    } catch {
      // Missing, non-executable, and broken PATH entries are not Node candidates.
    }
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
