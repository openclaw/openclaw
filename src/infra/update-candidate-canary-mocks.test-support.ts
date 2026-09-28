// Mock factories load before the production graph; keep their module free of runtime imports.
export function mockCanaryChildProcesses(
  original: typeof import("node:child_process"),
  spawn: typeof original.spawn,
) {
  return {
    ...original,
    spawn: new Proxy(original.spawn, {
      apply(target, thisArg, args) {
        const argv: unknown = args[1];
        if (
          Array.isArray(argv) &&
          typeof argv[0] === "string" &&
          /[/\\]dist[/\\](?:index|infra[/\\]update-migrated-finalize\.worker)\.js$/.test(argv[0])
        ) {
          return Reflect.apply(spawn, thisArg, args);
        }
        return Reflect.apply(target, thisArg, args);
      },
    }),
  };
}

export function mockCanarySnapshotCommands(
  original: typeof import("../process/exec.js"),
  snapshot: typeof original.runUtf8CommandWithTimeout,
) {
  return {
    ...original,
    runUtf8CommandWithTimeout: (...args: Parameters<typeof original.runUtf8CommandWithTimeout>) => {
      if (args[0].some((arg) => /[/\\]update-candidate-state\.worker\.[cm]?[jt]s$/.test(arg))) {
        return snapshot(...args);
      }
      return original.runUtf8CommandWithTimeout(...args);
    },
  };
}
